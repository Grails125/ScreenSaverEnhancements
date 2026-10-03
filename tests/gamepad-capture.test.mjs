import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

test('black overlay unregisters only its own modern Steam input capture', () => {
  const handlers = [];
  const navigation = {
    SetCatchAllGamepadInput(handler) {
      handlers.push(handler);
      return { Unregister() { handlers.splice(handlers.indexOf(handler), 1); } };
    },
  };
  const module = { exports: {} };
  const source = readFileSync(new URL('../src/useCatchAllGamepad.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    module, exports: module.exports,
    require() { return { useRef: value => ({ current: value }), useCallback: fn => fn }; },
    window: { SteamUIStore: { NavigationManager: navigation } },
  });
  const existing = () => {};
  navigation.SetCatchAllGamepadInput(existing);
  const capture = module.exports.useCatchAllGamepad();
  capture.subscribe(() => {});
  capture.release();
  capture.release();
  assert.deepEqual(handlers, [existing]);
});
