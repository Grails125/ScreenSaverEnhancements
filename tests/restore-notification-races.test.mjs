import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = ts.createSourceFile('index.tsx', fs.readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function fixture() {
  const names = ['notify', 'notifyInhibitState', 'cancelPendingRestoreNotification', 'scheduleRestoreNotification', 'synchronizeRuntimeState'];
  const declarations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
      declarations.push(`const ${node.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(declarations.length, names.length);
  const timers = new Map(), toasts = [], replies = [], restores = [];
  let serial = 0;
  const scope = {
    showNotify: true, timeout: undefined, restoreNotificationTimeout: null, restoreNotificationRevision: 0,
    pluginActive: true, displayOffInhibiting: false, backendInhibiting: false,
    getAppDisplayName: () => '', t: key => key, GiNightSleep() {}, React: { createElement: () => ({}) },
    console: { error() {} },
    enqueuePowerOperation: operation => operation(),
    withPowerTimeout: promise => promise, claimPowerOverride: async state => state,
    parsePowerOverrideState: value => value, parseSteamPowerSettings: value => value,
    backendState: { SetState() {} }, eventChannelDiagnostics: {},
    setConfiguredPowerSettings() {}, getPowerSyncAction: () => 'restore',
    stopInhibit: async () => { restores.push('restored'); },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    serverApi: {
      getInhibitStatus: () => new Promise(resolve => replies.push(value => resolve({dbus_requests: [], ...value}))),
      isRunning: async () => true, getPowerOverrideState: async () => ({active: true, snapshot: {}}),
      getSystemPowerSettings: async () => ({}),
      toaster: { toast: toast => toasts.push(toast) },
    },
  };
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(declarations.join('\n') +
    '\nglobalThis.sync=synchronizeRuntimeState;globalThis.schedule=scheduleRestoreNotification;globalThis.cancel=cancelPendingRestoreNotification;globalThis.notifyActive=()=>notifyInhibitState(undefined,true);',
  { compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText, scope);
  const fire = delay => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `No ${delay} ms timer`);
    timers.delete(entry[0]); entry[1].callback();
  };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const finish = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } };
  return { scope, toasts, replies, restores, fire, flush, finish };
}

test('the stable-window callback confirms power restoration instead of merely notifying', async () => {
  const f = fixture(); f.scope.schedule();
  assert.equal(f.restores.length, 0);
  f.fire(1500); await f.flush();
  assert.equal(f.restores.length, 0);
  f.replies[0]({is_inhibiting: false, dbus_requests: []}); await f.flush();
  assert.equal(f.restores.length, 1);
});

test('ordinary idle synchronization keeps the override until the stable-window confirmation', async () => {
  const f = fixture(); const pending = f.scope.sync(true);
  f.replies[0]({is_inhibiting: false}); await pending;
  assert.equal(f.restores.length, 0);
  f.fire(1500); f.replies[1]({is_inhibiting: false}); await f.flush();
  assert.equal(f.restores.length, 1);
});

test('a newly active application cancels actual restoration, not only its notification', async () => {
  const f = fixture(); f.scope.getPowerSyncAction = active => active ? 'none' : 'restore';
  const idle = f.scope.sync(true); f.replies[0]({is_inhibiting: false}); await idle;
  f.fire(1500); f.replies[1]({is_inhibiting: true}); await f.flush();
  assert.equal(f.restores.length, 0);
});

test('manual monitor stop restores immediately without a stable-window delay', async () => {
  const f = fixture(); f.scope.serverApi.isRunning = async () => false;
  const pending = f.scope.sync(); f.replies[0]({is_inhibiting: false}); await pending;
  assert.equal(f.restores.length, 1);
});

test('a backend that stops during the stable window still releases its power override', async () => {
  const f = fixture(); f.scope.schedule();
  f.scope.serverApi.isRunning = async () => false;
  f.fire(1500); f.replies[0]({is_inhibiting: false}); await f.flush();
  assert.equal(f.restores.length, 1);
});

test('an in-flight restore query cannot create a notification after plugin disposal', async () => {
  const f = fixture(); f.scope.schedule(); f.fire(1500);
  f.scope.clearTimeout(f.scope.timeout); f.scope.pluginActive = false; f.scope.cancel();
  f.replies[0]({ is_inhibiting: false }); await f.flush(); f.finish();
  assert.equal(f.toasts.length, 0);
});

test('cancelling an in-flight restore query invalidates its later response', async () => {
  const f = fixture(); f.scope.schedule(); f.fire(1500); f.scope.cancel();
  f.replies[0]({ is_inhibiting: false }); await f.flush(); f.finish();
  assert.equal(f.toasts.length, 0);
});

test('a newer inhibit state suppresses a restore toast already scheduled by a completed query', async () => {
  const f = fixture(); f.scope.schedule(); f.fire(1500);
  f.replies[0]({ is_inhibiting: false }); await f.flush();
  f.scope.backendInhibiting = true; f.scope.cancel(); f.finish();
  assert.equal(f.toasts.length, 0);
});

test('only the newest restore check can schedule the final toast', async () => {
  const f = fixture(); f.scope.schedule(); f.fire(1500); f.scope.schedule(); f.fire(1500);
  f.replies[1]({ is_inhibiting: false }); await f.flush();
  f.replies[0]({ is_inhibiting: false }); await f.flush(); f.finish();
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'Plugin Power Settings Restored');
});

test('notification preferences and disposal are checked when the toast actually fires', () => {
  for (const change of [scope => { scope.showNotify = false; }, scope => { scope.pluginActive = false; }]) {
    const f = fixture(); f.scope.notifyActive(); change(f.scope); f.finish();
    assert.equal(f.toasts.length, 0);
  }
});

test('an active restore query still produces exactly one normal recovery notification', async () => {
  const f = fixture(); f.scope.schedule(); f.fire(1500);
  f.replies[0]({ is_inhibiting: false }); await f.flush(); f.finish();
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'Plugin Power Settings Restored');
});

test('cancelling a restore check leaves an ordinary active notification intact', () => {
  const f = fixture(); f.scope.notifyActive(); f.scope.cancel(); f.finish();
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'Inhibit');
});

// Keep the restore, serialized queue and native writer real; fake only RPCs and time.
function retryFixture() {
  const load = file => {
    const module = {exports: {}};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
    }).outputText, {module, exports: module.exports, setTimeout, clearTimeout});
    return module.exports;
  };
  const power = load('../src/powerSettings.ts');
  const runtime = load('../src/runtimeSync.ts');
  const lifecycle = load('../src/powerLifecycle.ts');
  const normal = {batteryDim: 300, acDim: 300, batterySuspend: 600, acSuspend: 600};
  const zero = {batteryDim: 0, acDim: 0, batterySuspend: 0, acSuspend: 0};
  let override = {active: true, snapshot: {...normal}}, system = {...zero}, serial = 0;
  const timers = new Map(), toasts = [], errors = [], handlers = {};
  const state = {running: true, inhibiting: false, queryFailures: 0, writeFailures: 0, suspendWriteFailures: 0, reads: 0, writes: 0};
  const applyNative = data => {
    for (const row of data.trim().split('\n')) { const [key, value] = JSON.parse(row); system[key] = value; }
  };
  const scope = {
    ...power, ...runtime, showNotify: true, timeout: undefined,
    restoreNotificationTimeout: null, restoreNotificationRevision: 0,
    pluginActive: true, displayOffInhibiting: false, backendInhibiting: true,
    powerOperation: Promise.resolve(), configuredPowerSettings: {...normal},
    unsubscribeSettingsChanged: null, unsubscribeInhibitStateChanged: null,
    pushListenerHealth: {markConnected() {}, markDisconnected() {}},
    getAppDisplayName: () => '', t: key => key, GiNightSleep() {}, React: {createElement: () => ({})},
    console: {error: (...args) => errors.push(args)},
    withPowerTimeout: promise => promise, claimPowerOverride: async value => value,
    getPowerOverrideState: async () => override,
    endPowerOverride: async () => { override = {active: false, snapshot: null}; return true; },
    backendState: {SetState() {}}, eventChannelDiagnostics: {}, setConfiguredPowerSettings() {},
    nativePowerWriter: lifecycle.createNativePowerWriter({}),
    SettingDef: {battery_idle: 'batteryDim', ac_idle: 'acDim', battery_suspend: 'batterySuspend', ac_suspend: 'acSuspend'},
    genSettings: (key, value) => JSON.stringify([key, value]) + '\n',
    updateIdleSetting: async data => {
      state.writes++;
      if (state.writeFailures-- > 0) throw Error('native write failed');
      applyNative(data);
    },
    updateSuspendSetting: async data => {
      if (state.suspendWriteFailures-- > 0) throw Error('native suspend write failed');
      applyNative(data);
    },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, {callback, delay}); return id; },
    clearTimeout: id => timers.delete(id),
    serverApi: {
      isRunning: async () => state.running,
      getInhibitStatus: async () => {
        state.reads++;
        if (state.queryFailures-- > 0) throw Error('confirmation query failed');
        return {is_inhibiting: state.inhibiting, dbus_requests: []};
      },
      getPowerOverrideState: async () => override,
      getSystemPowerSettings: async () => ({...system}),
      subscribeSettingsChanged: callback => { handlers.settings = callback; return () => {}; },
      subscribeInhibitStateChanged: callback => { handlers.inhibit = callback; return () => {}; },
      toaster: {toast: toast => toasts.push(toast)},
    },
  };
  const names = ['updateSetting', 'stopInhibit', 'enqueuePowerOperation', 'notify', 'notifyInhibitState',
    'cancelPendingRestoreNotification', 'scheduleRestoreNotification', 'synchronizeRuntimeState',
    'runtimeSyncScheduler', 'disconnectPushListeners', 'reconnectPushListeners'];
  const declarations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) declarations.push(`const ${node.getText(source)};`);
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(declarations.length, names.length);
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(declarations.join('\n') + names.map(name => `\nglobalThis.${name}=${name};`).join(''), {
    compilerOptions: {target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React},
  }).outputText, scope);
  scope.reconnectPushListeners();
  const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
  return {
    scope, state, normal, zero, toasts, errors, flush,
    system: () => ({...system}), override: () => override,
    delays: () => [...timers.values()].map(timer => timer.delay),
    async release() { handlers.inhibit(); await flush(); },
    async fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `No ${delay} ms timer`);
      timers.delete(entry[0]); entry[1].callback(); await flush();
    },
  };
}

for (const fault of ['queryFailures', 'writeFailures']) {
  test(`delayed restoration retries one ${fault} through a fresh query and restores before notifying`, async () => {
    const f = retryFixture(); await f.release();
    assert.deepEqual(f.delays(), [1500]); assert.deepEqual(f.system(), f.zero);
    f.state[fault] = 1; await f.fire(1500);
    assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, false);
    assert.ok(f.errors.length > 0); assert.equal(f.override().active, true);
    assert.deepEqual(f.system(), f.zero); assert.equal(f.toasts.length, 0);
    assert.deepEqual(f.delays(), [3000]);
    await f.fire(3000);
    assert.equal(f.state.reads, 3); assert.equal(f.override().active, false);
    assert.deepEqual(f.system(), f.normal);
    assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, true);
    await f.fire(2000);
    assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'Plugin Power Settings Restored');
    assert.deepEqual(f.delays(), []);
  });

  test(`persistent ${fault} stops after three increasing-backoff retries`, async () => {
    const f = retryFixture(); await f.release(); f.state[fault] = Infinity;
    for (const delay of [1500, 3000, 6000, 12000]) await f.fire(delay);
    assert.equal(f.state.reads, 5); assert.equal(f.override().active, true);
    assert.deepEqual(f.system(), f.zero); assert.deepEqual(f.delays(), []);
    assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, false);
    assert.equal(f.toasts.length, 0);
  });
}

test('a failed second native stage retains recovery until a retry restores the complete profile', async () => {
  const f = retryFixture(); await f.release(); f.state.suspendWriteFailures = 1;
  await f.fire(1500);
  assert.deepEqual(f.system(), {...f.normal, batterySuspend: 0, acSuspend: 0});
  assert.equal(f.override().active, true); assert.equal(f.toasts.length, 0);
  assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, false);
  assert.deepEqual(f.delays(), [3000]);
  await f.fire(3000);
  assert.equal(f.state.reads, 3); assert.equal(f.state.writes, 2);
  assert.deepEqual(f.system(), f.normal); assert.equal(f.override().active, false);
  assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, true);
  await f.fire(2000);
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'Plugin Power Settings Restored');
  assert.deepEqual(f.delays(), []);
});

test('a new source cancels the pending backoff without restoring its active override', async () => {
  const f = retryFixture(); await f.release(); f.state.queryFailures = 1;
  await f.fire(1500); assert.deepEqual(f.delays(), [3000]);
  f.state.inhibiting = true; await f.release();
  assert.deepEqual(f.delays(), []); assert.deepEqual(f.system(), f.zero);
  assert.equal(f.override().active, true); assert.equal(f.state.writes, 0);
});

test('a new restore revision replaces the old backoff with its own stable window', async () => {
  const f = retryFixture(); await f.release(); f.state.queryFailures = 1;
  await f.fire(1500); assert.deepEqual(f.delays(), [3000]);
  f.scope.scheduleRestoreNotification();
  assert.deepEqual(f.delays(), [1500]);
  await f.fire(1500); assert.deepEqual(f.system(), f.normal);
  assert.equal(f.state.writes, 1);
});

for (const invalidation of ['new revision', 'new source', 'unload']) {
  test(`a late failed confirmation cannot revive a retry after ${invalidation}`, async () => {
    const f = retryFixture(); await f.release();
    const read = f.scope.serverApi.getInhibitStatus;
    let reject;
    f.scope.serverApi.getInhibitStatus = () => new Promise((_, fail) => { reject = fail; });
    await f.fire(1500); assert.equal(typeof reject, 'function');
    f.scope.serverApi.getInhibitStatus = read;
    if (invalidation === 'new revision') f.scope.scheduleRestoreNotification();
    else if (invalidation === 'new source') { f.state.inhibiting = true; await f.release(); }
    else { f.scope.pluginActive = false; f.scope.cancelPendingRestoreNotification(); }
    reject(Error('late confirmation failure')); await f.flush();
    assert.deepEqual(f.delays(), invalidation === 'new revision' ? [1500] : []);
    assert.deepEqual(f.system(), f.zero); assert.equal(f.state.writes, 0);
    if (invalidation === 'new revision') {
      await f.fire(1500); assert.deepEqual(f.system(), f.normal);
      assert.equal(f.state.writes, 1);
    }
  });
}

test('unload cancels a pending recovery backoff', async () => {
  const f = retryFixture(); await f.release(); f.state.queryFailures = 1;
  await f.fire(1500); assert.deepEqual(f.delays(), [3000]);
  f.scope.pluginActive = false; f.scope.cancelPendingRestoreNotification(); await f.flush();
  assert.deepEqual(f.delays(), []); assert.equal(f.state.writes, 0);
});

test('manual monitor stop cancels the backoff and restores without waiting for it', async () => {
  const f = retryFixture(); await f.release(); f.state.queryFailures = 1;
  await f.fire(1500); assert.deepEqual(f.delays(), [3000]);
  f.state.running = false;
  await f.scope.enqueuePowerOperation(() => f.scope.synchronizeRuntimeState());
  assert.deepEqual(f.delays(), []); assert.deepEqual(f.system(), f.normal);
  assert.equal(f.override().active, false); assert.equal(f.state.writes, 1);
});

test('a recovery retry waits behind an existing power operation before querying or writing', async () => {
  const f = retryFixture(); await f.release(); f.state.queryFailures = 1;
  await f.fire(1500);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const operation = f.scope.enqueuePowerOperation(() => gate);
  await f.fire(3000);
  assert.equal(f.state.reads, 2); assert.equal(f.state.writes, 0);
  release(); await operation; await f.flush();
  assert.equal(f.state.reads, 3); assert.deepEqual(f.system(), f.normal);
});

for (const fault of ['writeFailures', 'suspendWriteFailures']) {
  test(`backend stop during a retry keeps the remaining recovery budget after ${fault}`, async () => {
    const f = retryFixture(); await f.release(); f.state.queryFailures = 1;
    await f.fire(1500);
    f.state.running = false; f.state[fault] = 1;
    await f.fire(3000);
    assert.equal(f.override().active, true);
    assert.deepEqual(f.delays(), [6000]);
    assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, false);
    await f.fire(6000);
    assert.deepEqual(f.system(), f.normal); assert.equal(f.override().active, false);
    assert.deepEqual(f.delays(), []); assert.equal(f.toasts.length, 0);
    assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, true);
  });

  test(`manual stop immediately attempts restoration and retries ${fault} without the stable window`, async () => {
    const f = retryFixture(); await f.release();
    f.state.running = false; f.state[fault] = 1;
    await assert.rejects(f.scope.enqueuePowerOperation(() => f.scope.synchronizeRuntimeState()), /native/);
    assert.equal(f.state.writes, 1); assert.equal(f.override().active, true);
    assert.deepEqual(f.delays(), [3000]);
    await f.fire(3000);
    assert.deepEqual(f.system(), f.normal); assert.equal(f.override().active, false);
    assert.equal(f.state.writes, 2); assert.deepEqual(f.delays(), []);
    assert.equal(f.toasts.length, 0);
  });
}

test('a stopped backend does not reset the retry budget on every failed confirmation', async () => {
  const f = retryFixture(); await f.release(); f.state.queryFailures = 1;
  await f.fire(1500); f.state.running = false; f.state.writeFailures = Infinity;
  for (const delay of [3000, 6000, 12000]) await f.fire(delay);
  assert.equal(f.state.writes, 3); assert.deepEqual(f.delays(), []);
  assert.deepEqual(f.system(), f.zero); assert.equal(f.override().active, true);
  assert.equal(f.toasts.length, 0);
});

test('manual stop recovery remains bounded after persistent native failure', async () => {
  const f = retryFixture(); await f.release(); f.state.running = false; f.state.writeFailures = Infinity;
  await assert.rejects(f.scope.enqueuePowerOperation(() => f.scope.synchronizeRuntimeState()), /native/);
  for (const delay of [3000, 6000, 12000]) await f.fire(delay);
  assert.equal(f.state.writes, 4); assert.deepEqual(f.delays(), []);
  assert.deepEqual(f.system(), f.zero); assert.equal(f.override().active, true);
  assert.equal(f.scope.eventChannelDiagnostics.lastFullSyncSuccessful, false);
});

for (const invalidation of ['new source', 'unload']) {
  test(`a stopped-backend recovery backoff is cancelled by ${invalidation}`, async () => {
    const f = retryFixture(); await f.release(); f.state.running = false; f.state.writeFailures = 1;
    await assert.rejects(f.scope.enqueuePowerOperation(() => f.scope.synchronizeRuntimeState()), /native/);
    assert.deepEqual(f.delays(), [3000]);
    if (invalidation === 'new source') {
      f.state.running = true; f.state.inhibiting = true; await f.release();
    } else {
      f.scope.pluginActive = false; f.scope.cancelPendingRestoreNotification();
    }
    assert.deepEqual(f.delays(), []); assert.deepEqual(f.system(), f.zero);
    assert.equal(f.override().active, true); assert.equal(f.state.writes, 1);
  });

  test(`a late failed manual-stop write cannot revive recovery after ${invalidation}`, async () => {
    const f = retryFixture(); await f.release(); f.state.running = false;
    let reject;
    f.scope.updateIdleSetting = () => new Promise((_, fail) => { reject = fail; });
    const stop = f.scope.enqueuePowerOperation(() => f.scope.synchronizeRuntimeState());
    const rejected = assert.rejects(stop, /late native/);
    await f.flush(); assert.equal(typeof reject, 'function');
    if (invalidation === 'new source') {
      f.state.running = true; f.state.inhibiting = true; await f.release();
    } else {
      f.scope.pluginActive = false; f.scope.cancelPendingRestoreNotification();
    }
    reject(Error('late native failure')); await rejected; await f.flush();
    assert.deepEqual(f.delays(), []); assert.deepEqual(f.system(), f.zero);
    assert.equal(f.override().active, true);
  });
}
