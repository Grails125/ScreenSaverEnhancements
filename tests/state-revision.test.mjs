import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/state.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module, exports: module.exports });
const { StateNumber } = module.exports;

test('an unchanged user choice still invalidates an earlier async read without notifying listeners', () => {
  const state = new StateNumber(0), notifications = [];
  state.onStateChanged(value => notifications.push(value));
  const readRevision = state.GetRevision();
  state.SetState(0);
  assert.notEqual(state.GetRevision(), readRevision);
  assert.deepEqual(notifications, []);
  state.SetState(1);
  state.SetState(0);
  assert.notEqual(state.GetRevision(), readRevision);
  assert.deepEqual(notifications, [1, 0]);
});
