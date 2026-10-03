import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const tick = async () => {for (let n = 0; n < 20; n++) await Promise.resolve();};
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
function fixture(gate = null, failReads = false) {
  const handlers = {}, counts = {passes: 0, reads: 0};
  const read = value => {counts.reads++; return failReads ? Promise.reject(new Error('offline')) : gate ? gate.promise.then(() => value) : Promise.resolve(value);};
  const scope = {console: {error() {}}, powerOperation: Promise.resolve(), pluginActive: true,
    backendInhibiting: false, displayOffInhibiting: false, unsubscribeSettingsChanged: null,
    unsubscribeInhibitStateChanged: null, eventChannelDiagnostics: {},
    pushListenerHealth: {markDisconnected() {}, markConnected() {}},
    backendState: {SetState() {counts.passes++;}},
    claimPowerOverride: async value => value, parsePowerOverrideState: value => value,
    parseSteamPowerSettings: value => value, getPowerSyncAction: () => 'none', withPowerTimeout: p => p,
    cancelPendingRestoreNotification() {}, serverApi: {
      isRunning: () => read(true), getInhibitStatus: () => read({is_inhibiting: false, dbus_requests: []}),
      getPowerOverrideState: () => read({active: false, snapshot: null}), getSystemPowerSettings: () => read({}),
      subscribeSettingsChanged: cb => {handlers.settings = cb; return () => delete handlers.settings;},
      subscribeInhibitStateChanged: cb => {handlers.inhibit = cb; return () => delete handlers.inhibit;},
    }};
  const schedulerFile = new URL('../src/runtimeSync.ts', import.meta.url);
  if (existsSync(schedulerFile)) {
    const module = {exports: {}};
    vm.runInNewContext(ts.transpileModule(readFileSync(schedulerFile, 'utf8'), {
      compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
    }).outputText, {module, exports: module.exports});
    scope.createRuntimeSyncScheduler = module.exports.createRuntimeSyncScheduler;
  }
  const source = ts.createSourceFile('index.tsx', readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['enqueuePowerOperation', 'synchronizeRuntimeState', 'runtimeSyncScheduler', 'disconnectPushListeners', 'reconnectPushListeners'];
  const bits = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) bits.push(`const ${node.getText(source)};`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(bits.join('\n') + '\nglobalThis.connect=reconnectPushListeners;globalThis.enqueue=enqueuePowerOperation;', {
    compilerOptions: {target: ts.ScriptTarget.ES2020},
  }).outputText, scope);
  scope.connect();
  return {scope, handlers, counts};
}

test('a push burst does not queue a full sync for every event ahead of a user action', async () => {
  const {scope, handlers, counts} = fixture();
  for (let n = 0; n < 20; n++) handlers.settings();
  let atAction;
  await scope.enqueue(async () => {atAction = counts.passes;});
  await tick();
  assert.ok(atAction <= 1, `user operation waited behind ${atAction} sync passes`);
  assert.ok(counts.reads <= 8, `push burst performed ${counts.reads} reads`);
});

test('events arriving during a sync leave at most one follow-up behind the queued user action', async () => {
  const gate = deferred(), {scope, handlers, counts} = fixture(gate);
  handlers.settings(); await tick();
  for (let n = 0; n < 20; n++) handlers.inhibit();
  let atAction;
  const action = scope.enqueue(async () => {atAction = counts.passes;});
  gate.resolve(); await action; await tick();
  assert.equal(atAction, 1);
  assert.equal(counts.passes, 2);
  assert.equal(counts.reads, 8);
});

test('a failed reconnect sync stops retrying until another event or health check', async () => {
  const {handlers, counts} = fixture(null, true);
  for (let n = 0; n < 20; n++) handlers.settings();
  await tick(); await tick();
  assert.equal(counts.reads, 8);
  await tick(); assert.equal(counts.reads, 8);
});

test('merged inhibit events retain notification intent and cancellation suppresses queued syncs', async () => {
  const create = fixture().scope.createRuntimeSyncScheduler, operations = [], notifications = [];
  const scheduler = create({enqueue: operation => {operations.push(operation); return Promise.resolve().then(operation);},
    synchronize: async notify => {notifications.push(notify);}, isActive: () => true, onError() {}});
  scheduler.request(); scheduler.request(true); scheduler.request();
  await tick(); assert.deepEqual(notifications, [true]); assert.equal(operations.length, 1);
  scheduler.request(true); scheduler.cancel(); await tick();
  assert.deepEqual(notifications, [true]);
});

test('inhibit events during a read request a notified follow-up without delaying user work', async () => {
  const create = fixture().scope.createRuntimeSyncScheduler, gate = deferred(), notifications = [];
  let tail = Promise.resolve();
  const scheduler = create({enqueue: operation => {const result = tail.then(operation); tail = result.catch(() => {}); return result;},
    synchronize: async notify => {notifications.push(notify); await gate.promise;}, isActive: () => true, onError() {}});
  scheduler.request(); await tick(); scheduler.request(true); scheduler.request();
  gate.resolve(); await tick();
  assert.deepEqual(notifications, [false, true]);
});

test('a failed notified sync preserves its notification intent for the single reconnect retry', async () => {
  const create = fixture().scope.createRuntimeSyncScheduler, notifications = [];
  let scheduler;
  scheduler = create({enqueue: operation => Promise.resolve().then(operation),
    synchronize: async notify => {notifications.push(notify); if (notifications.length === 1) throw new Error('offline');},
    isActive: () => true, onError: (_error, recover) => {if (recover) scheduler.request(false, false);}});
  scheduler.request(true); await tick();
  assert.deepEqual(notifications, [true, true]);
});
