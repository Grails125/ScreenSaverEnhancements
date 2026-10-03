import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const normal = { batteryDim: 300, acDim: 300, batterySuspend: 600, acSuspend: 600 };
const lifecycle = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/powerLifecycle.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: lifecycle, exports: lifecycle.exports, setTimeout, clearTimeout });

function loadFunctions(scope, names) {
  const bits = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) bits.push(node.getText(ast));
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
      bits.push(`const ${node.getText(ast)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(bits.length, names.length);
  const exported = names.map(name => `globalThis.${name} = ${name};`).join('\n');
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(bits.join('\n') + '\n' + exported, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, scope);
}

function fixture({ inhibiting = false, recoveryActive = inhibiting, failSuspend = 0, failRollback = false } = {}) {
  let system = { ...normal };
  let marker = recoveryActive ? { active: true, snapshot: { ...normal } } : { active: false, snapshot: null };
  let idleWrites = 0;
  const write = data => {
    for (const line of data.trim().split('\n')) {
      const [key, value] = JSON.parse(line);
      system[key] = value;
    }
  };
  const scope = {
    console: { warn() {}, error() {} },
    configuredPowerSettings: { ...normal }, backendInhibiting: inhibiting, displayOffInhibiting: false,
    powerOwner: 'instance', ownershipUncertain: false,
    pluginActive: true, powerOperation: Promise.resolve(),
    powerLifecycle: { recordPowerWrite() {} },
    nativePowerWriter: lifecycle.exports.createNativePowerWriter({}, { timeoutMs: 5 }),
    SettingDef: { battery_idle: 'batteryDim', ac_idle: 'acDim', battery_suspend: 'batterySuspend', ac_suspend: 'acSuspend' },
    genSettings: (key, value) => JSON.stringify([key, value]) + '\n',
    updateIdleSetting: async data => {
      if (idleWrites++ > 0 && failRollback) throw new Error('rollback failed');
      write(data);
    },
    updateSuspendSetting: async data => {
      if (failSuspend-- > 0) throw new Error('suspend failed');
      write(data);
    },
    beginPowerOverride: async snapshot => { marker = { active: true, snapshot: { ...snapshot }, owner: 'instance' }; return true; },
    endPowerOverride: async () => { marker = { active: false, snapshot: null }; return true; },
    getPowerOverrideState: async () => marker,
    shouldApplyPowerSettingsImmediately: active => !active,
    notifyInhibitState() {},
  };
  loadFunctions(scope, ['updateSetting', 'setConfiguredPowerSettings', 'activateInhibit',
    'applyConfiguredPowerSettings', 'stopInhibit', 'enqueuePowerOperation', 'claimPowerOverride']);
  return { scope, system: () => system, marker: () => marker };
}

test('a partial inhibit write rolls back the original profile before clearing recovery', async () => {
  const state = fixture({ failSuspend: 1 });
  await assert.rejects(state.scope.activateInhibit(normal), /suspend failed/);
  assert.deepEqual(state.system(), normal);
  assert.equal(state.marker().active, false);
});

test('a failed rollback preserves the original recovery snapshot for a later retry', async () => {
  const state = fixture({ failSuspend: 1, failRollback: true });
  await assert.rejects(state.scope.activateInhibit(normal), /suspend failed/);
  assert.equal(state.marker().active, true);
  assert.deepEqual(state.marker().snapshot, normal);
});

test('editing the profile during inhibition changes the profile restored at stop', async () => {
  const state = fixture({ inhibiting: true });
  const desired = { ...normal, batteryDim: 900 };
  await state.scope.applyConfiguredPowerSettings(desired);
  assert.deepEqual(state.marker().snapshot, desired);
  state.scope.backendInhibiting = false;
  await state.scope.stopInhibit(false);
  assert.deepEqual(state.system(), desired);
});

test('a rejected recovery snapshot update does not change the configured profile', async () => {
  const state = fixture({ inhibiting: true });
  state.scope.beginPowerOverride = async () => false;
  await assert.rejects(state.scope.applyConfiguredPowerSettings({ ...normal, batteryDim: 900 }));
  assert.deepEqual(state.scope.configuredPowerSettings, normal);
});

test('queued events from an unloaded instance cannot write power settings', async () => {
  const state = fixture();
  let release;
  state.scope.powerOperation = new Promise(resolve => { release = resolve; });
  const result = state.scope.enqueuePowerOperation(() => state.scope.updateSetting(0, 0, 0, 0));
  state.scope.pluginActive = false;
  release();
  await result;
  assert.deepEqual(state.system(), normal);
});

test('editing after failed recovery cannot leave an older snapshot that undoes the new profile', async () => {
  const state = fixture({ recoveryActive: true });
  const desired = { ...normal, batteryDim: 900 };
  await state.scope.applyConfiguredPowerSettings(desired);
  assert.deepEqual(state.system(), desired);
  assert.equal(state.marker().active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.scope.configuredPowerSettings)), desired);
});

test('an ordinary profile edit arms recovery before a partial native failure', async () => {
  const state = fixture({ failSuspend: 1 });
  await assert.rejects(state.scope.applyConfiguredPowerSettings({ ...normal, batteryDim: 900 }), /suspend failed/);
  assert.equal(state.marker().active, true);
  assert.deepEqual(state.marker().snapshot, normal);
});

test('a started editor can finish its native transaction during plugin disposal', async () => {
  const state = fixture();
  state.scope.pluginActive = false;
  const desired = { ...normal, batteryDim: 900 };
  await state.scope.applyConfiguredPowerSettings(desired, true);
  assert.deepEqual(state.system(), desired);
  assert.equal(state.marker().active, false);
});
