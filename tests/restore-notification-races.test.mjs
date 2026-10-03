import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = ts.createSourceFile('index.tsx', fs.readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function fixture() {
  const names = ['notify', 'notifyInhibitState', 'cancelPendingRestoreNotification', 'scheduleRestoreNotification'];
  const declarations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
      declarations.push(`const ${node.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(declarations.length, names.length);
  const timers = new Map(), toasts = [], replies = [];
  let serial = 0;
  const scope = {
    showNotify: true, timeout: undefined, restoreNotificationTimeout: null, restoreNotificationRevision: 0,
    pluginActive: true, displayOffInhibiting: false, backendInhibiting: false,
    getAppDisplayName: () => '', t: key => key, GiNightSleep() {}, React: { createElement: () => ({}) },
    console: { error() {} },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    serverApi: {
      getInhibitStatus: () => new Promise(resolve => replies.push(resolve)),
      toaster: { toast: toast => toasts.push(toast) },
    },
  };
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(declarations.join('\n') +
    '\nglobalThis.schedule=scheduleRestoreNotification;globalThis.cancel=cancelPendingRestoreNotification;globalThis.notifyActive=()=>notifyInhibitState(undefined,true);',
  { compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText, scope);
  const fire = delay => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `No ${delay} ms timer`);
    timers.delete(entry[0]); entry[1].callback();
  };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const finish = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } };
  return { scope, toasts, replies, fire, flush, finish };
}

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
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'UnInhibit');
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
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'UnInhibit');
});

test('cancelling a restore check leaves an ordinary active notification intact', () => {
  const f = fixture(); f.scope.notifyActive(); f.scope.cancel(); f.finish();
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].body, 'Inhibit');
});
