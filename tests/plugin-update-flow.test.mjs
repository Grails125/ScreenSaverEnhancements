import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/usePluginUpdate.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function fixture(overrides = {}) {
  const slots = []; let cursor = 0, timers = 0, restarts = 0, versionReads = 0;
  const installs = [], toasts = [];
  const react = {
    createElement: () => null,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };
  const api = {
    checkUpdate: async () => ({ has_update: true, current: '2.0.0', latest: '2.0.1',
      notes: 'fixes', download_url: 'https://example.invalid/plugin.zip', sha256: 'abc', error: '' }),
    installPluginUpdate: async request => { installs.push(request); },
    getInstalledPluginVersion: async () => { versionReads++; return '2.0.1'; },
    restartDecky: async () => { restarts++; },
    toaster: { toast: value => toasts.push(value) },
    ...overrides,
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: id => id === 'react' ? react : { GiNightSleep() {} },
    console: { warn() {}, error() {} },
    setTimeout() { timers++; throw new Error('Plugin must not poll the native installer'); },
  });
  return {
    render() { cursor = 0; return module.exports.usePluginUpdate(api, () => 1, () => true, key => key); },
    installs, toasts,
    stats: () => ({ timers, restarts, versionReads }),
  };
}

test('opening Decky installation leaves download, activation and cancellation to its native installer', async () => {
  const state = fixture();
  await state.render().checkUpdate();
  await state.render().installUpdate();
  assert.equal(state.installs.length, 1);
  assert.equal(state.installs[0].version, '2.0.1');
  assert.deepEqual(state.stats(), { timers: 0, restarts: 0, versionReads: 0 });
  assert.equal(state.toasts.some(toast => toast.title === 'Update Install Failed'), false);
  assert.equal(state.render().installingUpdate, false);
});

test('a failure to open the native installer is reported and allows retry', async () => {
  let fail = true;
  const state = fixture({ installPluginUpdate: async () => {
    if (fail) throw Error('loader unavailable');
  } });
  await state.render().checkUpdate();
  await state.render().installUpdate();
  assert.equal(state.toasts.at(-1).title, 'Update Install Failed');
  assert.equal(state.render().installingUpdate, false);
  fail = false;
  await state.render().installUpdate();
  assert.deepEqual(state.stats(), { timers: 0, restarts: 0, versionReads: 0 });
});
