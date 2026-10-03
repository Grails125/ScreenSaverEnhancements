import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

function fixture(overrides = {}) {
  const slots = [];
  let cursor = 0, cleanup, effectMounted = false, resolveOld, count = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = {current: initial};
      return slots[index];
    },
    useEffect(effect) {
      if (!effectMounted) { cleanup = effect(); effectMounted = true; }
    },
  };
  const oldPromise = new Promise(resolve => { resolveOld = resolve; });
  const api = {
    getDiagnostics: () => ++count === 1 ? oldPromise : Promise.resolve({timestamp: 2, recentEvents: []}),
    clearDiagnosticEvents: async () => true,
    ...overrides,
  };
  const module = {exports: {}};
  const source = ts.transpileModule(readFileSync(new URL('../src/useDiagnosticsData.ts', import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: id => id === 'react' ? react : id === './diagnostics' ? {parseDiagnostics: value => value} : {},
    console: {warn() {}}, setTimeout, clearTimeout,
  });
  return {
    render() { cursor = 0; return module.exports.useDiagnosticsData(api, () => ({}), value => value); },
    resolveOld,
    unmount: () => cleanup?.(),
  };
}

test('clear events invalidates the previous pending refresh', async () => {
  const state = fixture();
  const first = state.render().refreshDiagnostics();
  await state.render().clearDiagnosticEvents();
  state.resolveOld({timestamp: 1, recentEvents: [{type: 'old'}]});
  await first;
  assert.equal(state.render().diagnostics.timestamp, 2);
  assert.equal(state.render().diagnostics.recentEvents.length, 0);
});

test('newer refresh remains authoritative when the earlier response arrives last', async () => {
  const state = fixture();
  const first = state.render().refreshDiagnostics();
  await state.render().refreshDiagnostics();
  state.resolveOld({timestamp: 1, recentEvents: [{type: 'old'}]});
  await first;
  assert.equal(state.render().diagnostics.timestamp, 2);
  assert.equal(state.render().diagnosticsLoading, false);
});

test('unmount invalidates pending diagnostics refresh', async () => {
  const state = fixture();
  const pending = state.render().refreshDiagnostics();
  state.unmount();
  state.resolveOld({timestamp: 1, recentEvents: []});
  await pending;
  assert.equal(state.render().diagnostics, null);
});

for (const rejected of [false, true]) {
  test(`failed clear releases loading while ignoring the previous request (rejected=${rejected})`, async () => {
    const state = fixture({clearDiagnosticEvents: async () => {
      if (rejected) throw Error('backend unavailable');
      return false;
    }});
    const pending = state.render().refreshDiagnostics();
    await state.render().clearDiagnosticEvents();
    assert.equal(state.render().diagnosticsLoading, false);
    state.resolveOld({timestamp: 1, recentEvents: []});
    await pending;
    assert.equal(state.render().diagnostics, null);
  });
}
