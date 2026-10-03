import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const sf = ts.createSourceFile('index.tsx', fs.readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const mod = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/powerLifecycle.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: mod, exports: mod.exports, setTimeout, clearTimeout });
const { createPowerLifecycle, withPowerTimeout } = mod.exports;
const { createNativePowerWriter } = mod.exports;
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function load(scope) {
  const names = ['enqueuePowerOperation', 'initializePlugin'];
  const bits = []; let body, recovery;
  function visit(n) {
    if (ts.isVariableDeclaration(n) && names.includes(n.name.getText(sf))) bits.push('const ' + n.getText(sf) + ';');
    if (ts.isMethodDeclaration(n) && n.name.getText(sf) === 'onDismount') body = n.body.getText(sf);
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'onError'
        && n.initializer.getText(sf).includes('initialConfiguredProfileLoaded')) recovery=n.initializer.getText(sf);
    ts.forEachChild(n, visit);
  }
  visit(sf); assert.equal(bits.length, 2); assert.ok(body); assert.ok(recovery);
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(bits.join('\n') + '\nglobalThis.initialize=initializePlugin;globalThis.enqueue=enqueuePowerOperation;globalThis.nativeRecovery='+recovery+';globalThis.dismount=()=>' + body, {
    fileName: 'lifecycle.tsx', compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText, scope);
  return scope;
}
function fixture(host, dispose = async () => {}, events = [], prefix = '') {
  const lifecycle = createPowerLifecycle(host);
  const scope = {
    console: { error() {}, warn() {} }, pluginActive: true, powerLifecycle: lifecycle, powerOperation: lifecycle.ready,
    withPowerTimeout: (request, operation) => withPowerTimeout(request, operation, 5),
    displayOffSession: { dispose }, timeout: undefined, clearTimeout() {},
    powerEditor: { dispose: async () => {} },
    panelContent: { retire() {} },
    disposePluginSettings: api => {
      if (api !== scope.serverApi) throw new Error('Disposed the wrong settings runtime');
      scope.settingsDisposed = true;
    },
    runtimeSyncScheduler: {cancel() {}},
    disconnectPushListeners() {}, cancelPendingRestoreNotification() {}, reportDisplayOffError() {},
    restorePendingPowerOverride: async () => { events.push(prefix + 'restore'); },
    serverApi: { routerHook: { removeGlobalComponent() {} } },
    getPluginBooleanSetting: async () => false, getPluginNumberSetting: async (_api, _key, fallback) => fallback,
    BLACK_BACKGROUND_ENABLED: 'enabled', BLACK_BACKGROUND_OPACITY: 'opacity', SHOW_NOTIFY: 'notify',
    POWER_SETTING_KEYS: { batteryDim: 'bd', acDim: 'ad', batterySuspend: 'bs', acSuspend: 'as' },
    DEFAULT_POWER_SETTINGS: { batteryDim: 300, acDim: 300, batterySuspend: 600, acSuspend: 600 },
    opacityState: { SetState() {}, GetRevision: () => 0 }, overlayState: { SetState() {}, GetRevision: () => 0 }, backendState: { SetState() {} },
    clampOpacity: x => x, normalizePowerSettings: x => x, setConfiguredPowerSettings() {},
    showNotify: false, showNotifyState: { GetRevision: () => 0, SetState() {} },
    synchronizeRuntimeState: async () => { events.push(prefix + 'sync'); },
    readSystemPowerSettings: async () => null,
    resolveInitialPowerProfile() {},
    resolveInitialConfiguredProfile() {},
    reconnectPushListeners: () => { events.push(prefix + 'listen'); },
  };
  return load(scope);
}

test('initialization recovery and subscriptions proceed when an ordinary setting read is discarded', async () => {
  const events = [];
  const state = fixture({}, undefined, events);
  state.getPluginBooleanSetting = () => new Promise(() => {});
  await state.initialize();
  assert.deepEqual(events, ['sync', 'listen']);
});

test('factory disposal fences its settings registry before retiring panel content',async()=>{
  const state=fixture({});
  state.panelContent.retire=()=>assert.equal(state.settingsDisposed,true);
  state.dismount();
  assert.equal(state.settingsDisposed,true);
  await state.powerLifecycle.ready;
});

test('timed out native writes release cleanup and replacement initialization',async()=>{
  const host={},events=[],old=fixture(host,undefined,events,'old:');
  const writer=createNativePowerWriter(host,{timeoutMs:5});
  const operation=old.enqueue(()=>writer.write({batteryDim:0,acDim:0,batterySuspend:0,acSuspend:0},
    ()=>new Promise(()=>{}),async()=>{}));
  const rejected=assert.rejects(operation,/timed out/);
  await flush();
  old.dismount();
  const replacement=fixture(host,undefined,events,'new:');
  await replacement.initialize();await rejected;
  assert.deepEqual(events,['old:restore','new:sync','new:listen']);
});

test('factory initial overlay and opacity reads cannot undo a newer state revision',async()=>{
  const state=fixture({}),read=deferred();let overlayRevision=0,opacityRevision=0,overlay=0,opacity=1;
  state.overlayState={GetRevision:()=>overlayRevision,SetState:value=>{overlay=value;overlayRevision++;}};
  state.opacityState={GetRevision:()=>opacityRevision,SetState:value=>{opacity=value;opacityRevision++;}};
  state.getPluginBooleanSetting=()=>read.promise;
  state.getPluginNumberSetting=()=>read.promise;
  const initialized=state.initialize();await flush();
  state.overlayState.SetState(1);state.opacityState.SetState(0.4);
  read.resolve(0);await initialized;
  assert.equal(overlay,1);assert.equal(opacity,0.4);
});

test('factory notification reads cannot undo newer or same-value notification intent',async()=>{
  for (const [oldValue, latestValue] of [[false, true], [true, false]]) {
    const state=fixture({}),read=deferred();let revision=0,value=0;
    state.showNotifyState={GetRevision:()=>revision,SetState:next=>{value=next;revision++;}};
    state.getPluginBooleanSetting=()=>read.promise;
    const initialized=state.initialize();await flush();
    state.showNotify=latestValue;state.showNotifyState.SetState(latestValue?1:0);
    read.resolve(oldValue);await initialized;
    assert.equal(state.showNotify,latestValue);assert.equal(value,latestValue?1:0);
  }
});

test('factory notification initialization publishes the saved baseline to shared state',async()=>{
  const state=fixture({});let published=0;
  state.getPluginBooleanSetting=async()=>true;
  state.showNotifyState={GetRevision:()=>0,SetState:value=>{published=value;}};
  await state.initialize();assert.equal(state.showNotify,true);assert.equal(published,1);
});

test('the configured-profile gate releases before queued runtime synchronization completes',async()=>{
  const state=fixture({}),runtime=deferred();let loaded=null;
  state.resolveInitialConfiguredProfile=value=>{loaded=value;};
  state.synchronizeRuntimeState=async()=>{await runtime.promise;};
  const initialized=state.initialize();await flush();
  assert.equal(loaded,true);
  runtime.resolve();await initialized;
});

test('failed initial setting reads never authorize recovery of unknown default profile',async()=>{
  const state=fixture({});let loaded=null;
  state.resolveInitialConfiguredProfile=value=>{loaded=value;};
  state.getPluginNumberSetting=()=>new Promise(()=>{});
  await state.initialize();assert.equal(loaded,false);
});

test('replacement recovery arms the saved profile before the initial native read can consume polluted values',async()=>{
  const events=[],state=fixture({},undefined,events),loaded=deferred();let marker={active:false,owner:'replacement'};
  state.initialConfiguredProfileLoaded=loaded.promise;
  state.resolveInitialConfiguredProfile=loaded.resolve;
  state.powerOwner='replacement';
  state.setConfiguredPowerSettings=value=>{state.configuredPowerSettings=value;};
  state.getPowerOverrideState=async()=>marker;
  state.beginPowerOverride=async profile=>{marker={active:true,snapshot:profile,owner:'replacement'};events.push('arm');return true;};
  state.readSystemPowerSettings=async()=>{let profile;await state.enqueue(async()=>{
    events.push('read');assert.equal(marker.active,true);profile=marker.snapshot;
  });return profile;};
  const recovery=state.nativeRecovery(new Error('late repair failure'));
  await state.initialize();await recovery;
  assert.deepEqual(events,['sync','listen','arm','read']);
  assert.deepEqual(JSON.parse(JSON.stringify(marker.snapshot)),state.DEFAULT_POWER_SETTINGS);
});

test('an expired initial settings response cannot overwrite the recovered profile later', async () => {
  const events = [], late = deferred(), profiles = [];
  const state = fixture({}, undefined, events);
  state.getPluginNumberSetting = () => late.promise;
  state.setConfiguredPowerSettings = value => profiles.push(value);
  state.synchronizeRuntimeState = async () => { events.push('recovery'); profiles.push({ recovered: true }); };
  await state.initialize();
  late.resolve(0);
  await flush();
  assert.deepEqual(events, ['recovery', 'listen']);
  assert.deepEqual(profiles, [{ recovered: true }]);
});

test('disposing during an unresolved initial read still releases the initial profile gate', async () => {
  const state = fixture({});
  let completed = false, initial;
  state.resolveInitialPowerProfile = value => { completed = true; initial = value; };
  state.getPluginBooleanSetting = () => new Promise(() => {});
  const initialization = state.initialize();
  await flush();
  state.dismount();
  await initialization;
  assert.equal(completed, true);
  assert.equal(initial, null);
});

test('replacement waits for a started editor before disposing display and restoring power', async () => {
  const events = [], host = {}, pending = deferred();
  const state = fixture(host, async () => { events.push('display disposal'); }, events, 'old:');
  state.powerEditor.dispose = () => pending.promise;
  state.dismount();
  const replacement = fixture(host, undefined, events, 'new:').initialize();
  await flush();
  assert.deepEqual(events, []);
  pending.resolve();
  await replacement;
  assert.deepEqual(events, ['display disposal', 'old:restore', 'new:sync', 'new:listen']);
});
test('dismount retires cached panel synchronously before waiting for editor cleanup', async () => {
  const events=[], pending=deferred(), state=fixture({});
  state.panelContent.retire=()=>events.push('retire');
  state.powerEditor.dispose=()=>{events.push('editor');return pending.promise;};
  state.dismount();
  assert.deepEqual(events,['retire','editor']);
  pending.resolve();await state.powerLifecycle.ready;await flush();
});

test('replacement initialization waits for actual onDismount display disposal and power cleanup', async () => {
  const host = {}, gate = deferred(), events = [];
  const old = fixture(host, () => gate.promise, events, 'old:');
  assert.equal(old.dismount(), undefined);
  const replacement = fixture(host, undefined, events, 'new:');
  const initialized = replacement.initialize(); await flush();
  assert.deepEqual(events, []);
  gate.resolve(); await initialized;
  assert.deepEqual(events, ['old:restore', 'new:sync', 'new:listen']);
});

test('unload drains an in-flight power operation and skips queued inactive operations before replacement sync', async () => {
  const host = {}, gate = deferred(), events = [];
  const old = fixture(host, undefined, events, 'old:');
  old.powerOperation = gate.promise;
  const queued = old.enqueue(async () => events.push('obsolete'));
  old.dismount();
  const initialized = fixture(host, undefined, events, 'new:').initialize(); await flush();
  assert.deepEqual(events, []);
  gate.resolve(); await queued; await initialized;
  assert.deepEqual(events, ['old:restore', 'new:sync', 'new:listen']);
});

test('rejected display disposal still runs power restoration and releases replacement initialization', async () => {
  const host = {}, events = [];
  fixture(host, async () => { throw Error('display cleanup failed'); }, events, 'old:').dismount();
  await fixture(host, undefined, events, 'new:').initialize();
  assert.deepEqual(events, ['old:restore', 'new:sync', 'new:listen']);
});

test('display disposal can enqueue its own idle release without a barrier deadlock', async () => {
  const host = {}, events = []; let old;
  old = fixture(host, () => old.enqueue(async () => events.push('idle release'), true), events, 'old:');
  old.dismount(); await fixture(host, undefined, events, 'new:').initialize();
  assert.deepEqual(events, ['idle release', 'old:restore', 'new:sync', 'new:listen']);
});

test('a discarded recovery read has a bounded deadline and cannot pin replacement initialization', async () => {
  assert.equal(typeof withPowerTimeout, 'function');
  const host = {}, events = [];
  const old = fixture(host, undefined, events, 'old:');
  old.withPowerTimeout = (request, operation) => withPowerTimeout(request, operation, 5);
  old.parsePowerOverrideState = value => value;
  old.serverApi.getPowerOverrideState = () => new Promise(() => {});
  let readDeclaration;
  function findRead(n) {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'getPowerOverrideState') readDeclaration = n.getText(sf);
    ts.forEachChild(n, findRead);
  }
  findRead(sf); assert.ok(readDeclaration);
  vm.runInContext(ts.transpileModule('const ' + readDeclaration + ';globalThis.readRecovery=getPowerOverrideState;', {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, old);
  old.restorePendingPowerOverride = async () => {
    events.push('old:read');
    await old.readRecovery();
  };
  old.dismount();
  await fixture(host, undefined, events, 'new:').initialize();
  assert.deepEqual(events, ['old:read', 'new:sync', 'new:listen']);
});

test('a timed out metadata response stays rejected when the discarded response arrives late', async () => {
  const pending = deferred();
  await assert.rejects(withPowerTimeout(pending.promise, 'Save power recovery state', 5), /timed out/);
  pending.resolve(true);
  await flush();
});

function metadataWrappers(backend, owner = 'instance') {
  const names = ['getPowerOverrideState', 'beginPowerOverride', 'endPowerOverride', 'claimPowerOverride'];
  const bits = [];
  function visit(n) {
    if (ts.isVariableDeclaration(n) && names.includes(n.name.getText(sf))) bits.push('const ' + n.getText(sf) + ';');
    ts.forEachChild(n, visit);
  }
  visit(sf); assert.equal(bits.length, names.length);
  let revision = 0;
  const scope = { console: { warn() {} }, serverApi: backend, powerOwner: owner, ownershipUncertain: false,
    newPowerOwner: () => `revision-${++revision}`,
    withPowerTimeout: (request, operation) => withPowerTimeout(request, operation, 5),
    parsePowerOverrideState: value => value };
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(bits.join('\n') + names.map(name => `\nglobalThis.${name}=${name};`).join(''), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, scope);
  return scope;
}

test('actual recovery read wrapper rejects a discarded request instead of inventing inactive state', async () => {
  const api = metadataWrappers({ getPowerOverrideState: () => new Promise(() => {}) });
  await assert.rejects(api.getPowerOverrideState(), /Read power recovery state timed out/);
});

test('actual metadata wrappers carry instance owner and expected owner for backend compare-and-swap', async () => {
  const calls = [];
  const api = metadataWrappers({
    beginPowerOverride: async (...args) => { calls.push(['begin', ...args]); return true; },
    endPowerOverride: async (...args) => { calls.push(['end', ...args]); return true; },
  }, 'new-instance');
  const snapshot = { batteryDim: 300, acDim: 300, batterySuspend: 600, acSuspend: 600 };
  assert.equal(await api.beginPowerOverride(snapshot, null), true);
  assert.equal(await api.beginPowerOverride(snapshot, 'old-instance'), true);
  assert.equal(await api.endPowerOverride(), true);
  assert.equal(calls[0][3], null);
  assert.notEqual(calls[0][2], 'new-instance');
  assert.equal(calls[1][3], 'old-instance');
  assert.notEqual(calls[1][2], calls[0][2]);
  assert.equal(calls[2][0], 'end');
  assert.equal(calls[2][1], calls[1][2]);
  assert.notEqual(calls[2][2], calls[1][2]);
});

function delayedMetadata(kind, initiallyActive = true) {
  const snapshot = { batteryDim: 300, acDim: 300, batterySuspend: 600, acSuspend: 600 };
  let state = initiallyActive ? { active: true, owner: 'instance', snapshot }
    : { active: false, owner: null, snapshot: null }, release;
  let delay = true;
  const begin = (profile, owner, expected) => {
    if (state.owner !== expected || owner === expected) return false;
    state = { active: true, owner, snapshot: profile }; return true;
  };
  const end = (owner, nextOwner) => {
    if (state.owner !== owner) return false;
    state = { active: false, owner: nextOwner ?? null, snapshot: null }; return true;
  };
  const backend = {
    getPowerOverrideState: async () => state,
    beginPowerOverride: (profile, owner, expected) => {
      if (kind === 'begin' && delay) { delay = false; return new Promise(resolve => { release = () => resolve(begin(profile, owner, expected)); }); }
      return Promise.resolve(begin(profile, owner, expected));
    },
    endPowerOverride: (owner, nextOwner) => {
      if (kind === 'end' && delay) { delay = false; return new Promise(resolve => { release = () => resolve(end(owner, nextOwner)); }); }
      return Promise.resolve(end(owner, nextOwner));
    },
  };
  return { api: metadataWrappers(backend), state: () => state, release: () => release(), snapshot };
}

test('claiming an inactive revision blocks a delayed first begin after its metadata timeout', async () => {
  const state = delayedMetadata('begin', false);
  assert.equal(await state.api.beginPowerOverride(state.snapshot, null), false);
  const claimed = await state.api.claimPowerOverride(await state.api.getPowerOverrideState());
  assert.equal(claimed.active, false);
  assert.ok(claimed.owner);
  const beforeLate = state.state();
  state.release(); await flush();
  assert.deepEqual(state.state(), beforeLate);
  assert.equal(state.state().active, false);
});

for (const kind of ['begin', 'end']) {
  test(`timed out old ${kind} cannot mutate the same factory after uncertain ownership is reclaimed`, async () => {
    const state = delayedMetadata(kind);
    const result = kind === 'begin'
      ? await state.api.beginPowerOverride({ ...state.snapshot, batteryDim: 900 })
      : await state.api.endPowerOverride();
    assert.equal(result, false);
    const claimed = await state.api.claimPowerOverride(await state.api.getPowerOverrideState());
    assert.notEqual(claimed.owner, 'instance');
    const beforeLate = state.state();
    state.release(); await flush();
    assert.deepEqual(state.state(), beforeLate);
    assert.equal(state.state().active, true);
    assert.equal(state.state().snapshot.batteryDim, 300);
  });
}

test('native power handoff preserves a newer write when an older reader clears its record', () => {
  const host = {}, old = createPowerLifecycle(host), next = createPowerLifecycle(host);
  const profile = { batteryDim: 60, acDim: 300, batterySuspend: 300, acSuspend: 0 };
  old.recordPowerWrite(profile);
  const previous = next.getLastPowerWrite();
  profile.batteryDim = 0;
  assert.equal(previous.settings.batteryDim, 60);
  next.recordPowerWrite({ ...profile, batteryDim: 120 });
  old.clearPowerWrite(previous);
  assert.equal(next.getLastPowerWrite().settings.batteryDim, 120);
});
