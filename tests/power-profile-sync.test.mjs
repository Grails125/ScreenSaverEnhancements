import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const ast = ts.createSourceFile('index.tsx', readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const original = { batteryDim: 60, acDim: 300, batterySuspend: 300, acSuspend: 0 };
const zero = { batteryDim: 0, acDim: 0, batterySuspend: 0, acSuspend: 0 };
const settingsModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/powerSettings.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: settingsModule, exports: settingsModule.exports });
const lifecycleModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/powerLifecycle.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: lifecycleModule, exports: lifecycleModule.exports, setTimeout, clearTimeout });
const plain = value => JSON.parse(JSON.stringify(value));

function reader({ off = false, active = false, system = zero, snapshot = original, inhibit = false, gate = Promise.resolve(), lastWrite = null } = {}) {
  let reads = 0;
  const scope = {
    ...settingsModule.exports,
    console: { warn() {}, error() {} },
    pluginActive: true, powerOperation: gate, backendInhibiting: false, displayOffInhibiting: off,
    lastSystemPowerWrite: lastWrite,
    powerLifecycle: {
      getLastPowerWrite: () => scope.lastSystemPowerWrite,
      clearPowerWrite: expected => { if (scope.lastSystemPowerWrite === expected) scope.lastSystemPowerWrite = null; },
    },
    withPowerTimeout: (request, operation) => lifecycleModule.exports.withPowerTimeout(request, operation, 5),
    serverApi: {
      getInhibitStatus: async () => { reads++; return { is_inhibiting: inhibit }; },
      getSystemPowerSettings: async () => system,
      getPowerOverrideState: async () => ({ active, snapshot: active ? snapshot : null }),
    },
  };
  const names = ['enqueuePowerOperation', 'readSystemPowerSettings'];
  const bits = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) bits.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(bits.length, names.length);
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(bits.join('\n') + '\nglobalThis.read=readSystemPowerSettings;', {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, scope);
  return { scope, read: () => scope.read(), reads: () => reads };
}

test('display-off panel reads return the user snapshot instead of temporary zero timeouts', async () => {
  const state = reader({ off: true, active: true });
  assert.deepEqual(plain(await state.read()), original);
});

test('a persisted recovery snapshot remains authoritative without a backend inhibitor', async () => {
  const state = reader({ active: true, system: { ...zero, batteryDim: 60 } });
  assert.deepEqual(plain(await state.read()), original);
});

test('an active display override without a snapshot never synchronizes temporary zeros', async () => {
  assert.equal(await reader({ off: true }).read(), null);
});

test('a user profile with all timeouts disabled is still accepted outside inhibition', async () => {
  assert.deepEqual(plain(await reader().read()), zero);
});

test('a passive panel read waits for the current power mutation to finish', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const state = reader({ gate, system: original });
  const result = state.read();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.reads(), 0);
  release();
  assert.deepEqual(plain(await result), original);
});

test('a discarded passive read releases the power queue after its deadline', async () => {
  const state = reader();
  state.scope.serverApi.getSystemPowerSettings = () => new Promise(() => {});
  assert.equal(await state.read(), null);
  state.scope.serverApi.getSystemPowerSettings = async () => original;
  assert.deepEqual(plain(await state.read()), original);
});

test('a completed native write stays authoritative while the Steam disk config catches up', async () => {
  const state = reader({ lastWrite: { settings: original, at: Date.now() } });
  assert.deepEqual(plain(await state.read()), original);
  state.scope.serverApi.getSystemPowerSettings = async () => original;
  assert.deepEqual(plain(await state.read()), original);
  assert.equal(state.scope.lastSystemPowerWrite, null);
});

test('a replacement bundle reads its predecessor restoration while Steam still reports temporary zeros', async () => {
  const host = {};
  const old = lifecycleModule.exports.createPowerLifecycle(host);
  const replacement = lifecycleModule.exports.createPowerLifecycle(host);
  old.recordPowerWrite(original);
  const state = reader();
  state.scope.powerLifecycle = replacement;
  assert.deepEqual(plain(await state.read()), original);
  state.scope.serverApi.getSystemPowerSettings = async () => original;
  assert.deepEqual(plain(await state.read()), original);
  assert.equal(old.getLastPowerWrite(), null);
});
