import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
function declaration(file, name, bindings) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let text;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) text = `const ${node.getText(ast)};`;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(text, name);
  const compiled = ts.transpileModule(text, {fileName: file, compilerOptions: {target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React}}).outputText;
  const context = vm.createContext({...bindings, console});
  vm.runInContext(`${compiled}\nthis.subject=${name};`, context);
  return context.subject;
}
const module = {exports: {}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/settingEditing.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
}).outputText, {module, exports: module.exports});
const {createSettingEditor} = module.exports;
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const tick = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};

test('real monitor transaction serializes save, stop/start and power sync in user order', async () => {
  const gate = deferred(), calls = []; let saved = true, backend = true, ui;
  const editor = declaration('../src/index.tsx', 'monitorEditor', {
    RUN_ON_LOGIN: 'run', backendState: {GetState: () => 1},
    getEditor: (_key, initial, persist) => createSettingEditor(initial, persist),
    saveSetting: async (_key, value) => {calls.push(`save:${value}`); if (!value) await gate.promise; saved = value; return true;},
    serverApi: {startBackend: async () => {calls.push('start'); backend = true; return true;},
      stopBackend: async () => {calls.push('stop'); backend = false; return true;}, toaster: {toast() {}}},
    onMonitorChanged: async () => {calls.push('sync');}, notifyMonitorStatus() {}, isActive: () => true,
  });
  editor.subscribe(value => {ui = value;});
  const off = editor.edit(() => false), on = editor.edit(() => true);
  await tick(); assert.deepEqual(calls, ['save:false']); assert.equal(ui, true);
  gate.resolve(); await Promise.all([off, on]);
  assert.deepEqual(calls, ['save:false', 'stop', 'sync', 'save:true', 'start', 'sync']);
  assert.equal(saved, true); assert.equal(backend, true); assert.equal(ui, true);
});

test('a failed earlier monitor save leaves the later request and its display intact', async () => {
  const gate = deferred(); let ui, saved = true, backend = true;
  const editor = declaration('../src/index.tsx', 'monitorEditor', {
    RUN_ON_LOGIN: 'run', backendState: {GetState: () => 1},
    getEditor: (_key, initial, persist) => createSettingEditor(initial, persist),
    saveSetting: async (_key, value) => {if (!value) {await gate.promise; return false;} saved = value; return true;},
    serverApi: {startBackend: async () => {backend = true; return true;}, stopBackend: async () => {backend = false; return true;}, toaster: {toast() {}}},
    onMonitorChanged: async () => {}, notifyMonitorStatus() {}, isActive: () => true,
  });
  editor.subscribe(value => {ui = value;});
  const off = editor.edit(() => false), on = editor.edit(() => true);
  gate.resolve(); assert.equal(await off, false); assert.equal(ui, true); await on;
  assert.equal(saved, true); assert.equal(backend, true); assert.equal(ui, true);
});

test('unloading during monitor rollback prevents the old callback restarting a backend', async () => {
  const gate=deferred(),rollbackEntered=deferred(),calls=[];let active=true;
  const editor=declaration('../src/index.tsx','monitorEditor',{
    RUN_ON_LOGIN:'run',backendState:{GetState:()=>1},
    getEditor:(_key,initial,persist)=>createSettingEditor(initial,persist),
    saveSetting:async()=>true,
    serverApi:{stopBackend:async()=>{calls.push('stop');return false;},startBackend:async()=>{calls.push('start');return true;},toaster:{toast(){}}},
    setPluginSetting:async()=>{calls.push('rollback');rollbackEntered.resolve();await gate.promise;return true;},
    onMonitorChanged:async()=>{calls.push('sync');},notifyMonitorStatus(){},isActive:()=>active,
  });
  const pending=editor.edit(()=>false);await rollbackEntered.promise;assert.deepEqual(calls,['stop','rollback']);
  active=false;gate.resolve();await pending;assert.deepEqual(calls,['stop','rollback']);
});

test('real black-overlay opacity load preserves a slider edit made while loading', async () => {
  const gate = deferred(); let value = 1, revision = 0, visible;
  const opacityState = {GetState: () => value, GetRevision: () => revision, SetState: next => {value = next; revision++;}};
  const load = declaration('../src/blackOverlay.tsx', 'onOverlayChanged', {
    stateChangeTokenRef: {current: 0}, opacityState, serverApi: {},
    BLACK_BACKGROUND_OPACITY: 'opacity', BLACK_BACKGROUND_CLOSE_ON_ANY_KEY: 'any',
    getPluginNumberSetting: () => gate.promise, getPluginBooleanSetting: async () => false,
    clampOpacity: n => n, setOpacity: next => {value = next;}, setVisible: next => {visible = next;},
    stopCapture() {}, stopResumeCapture() {}, subscribeResumeFromSuspend() {}, closeOverlay() {},
  });
  const pending = load(1); opacityState.SetState(0.8); gate.resolve(0.5); await pending;
  assert.equal(value, 0.8); assert.equal(visible, true);
});
