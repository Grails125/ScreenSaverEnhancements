import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function subject(name, bindings) {
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = `const ${node.getText(ast)};`;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, name);
  const code = ts.transpileModule(declaration, {fileName: 'subject.tsx', compilerOptions: {target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React}}).outputText;
  const context = vm.createContext({...bindings, console});
  vm.runInContext(`${code}\nthis.subject=${name};`, context);
  return context.subject;
}
const module = {exports: {}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/settingEditing.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
}).outputText, {module, exports: module.exports});
const {createSettingEditor} = module.exports;
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const tick = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};

test('real removeApp handlers keep surviving rules after an earlier deletion fails', async () => {
  const firstSave = deferred(); let ui, stored = ['Music', 'Downloader'], count = 0;
  const editor = createSettingEditor(stored, async value => {
    if (++count === 1) {await firstSave.promise; return false;}
    stored = Array.from(value); return true;
  });
  editor.subscribe(value => {ui = Array.from(value);});
  const remove = subject('removeApp', {manualAppsEditor: editor, panelVisible: {current: true}, reportSaveFailure() {}});
  const first = remove('Music'), second = remove('Downloader');
  await tick(); firstSave.resolve(); await Promise.all([first, second]);
  assert.deepEqual(ui, ['Music']); assert.deepEqual(stored, ['Music']);
});

test('real initial black-settings load keeps the user edit that arrived during loading', async () => {
  const initialRead = deferred(); let enabled = false;
  const black = createSettingEditor(false, async () => true);
  black.subscribe(value => {enabled = value;});
  const load = subject('loadBlackBackgroundSettings', {
    blackBackgroundEditor: black, opacityEditor: createSettingEditor(1, async () => true),
    closeOnAnyKeyEditor: createSettingEditor(false, async () => true), parseBooleanSetting: value => value,
    getPluginBooleanSetting: (_api, key) => key === 'enabled' ? initialRead.promise : Promise.resolve(false),
    getPluginNumberSetting: async () => 1, clampOpacity: value => value,
    BLACK_BACKGROUND_ENABLED: 'enabled', BLACK_BACKGROUND_OPACITY: 'opacity', BLACK_BACKGROUND_CLOSE_ON_ANY_KEY: 'any',
    serverApi: {getSetting: async () => false}, isCurrentRequest: () => true, token: 1, setCloseOnAnyKey() {}, setCloseOnAnyKeyLoaded() {},
  });
  const pending = load(); const edit = black.edit(() => true);
  initialRead.resolve(false); await Promise.all([pending, edit]);
  assert.equal(enabled, true);
});

test('real debounce persistence keeps the later opacity after the earlier RPC fails', async () => {
  const firstSave = deferred(); let ui = 1, stored = 1, count = 0;
  const editor = createSettingEditor(1, async value => {
    if (++count === 1) {await firstSave.promise; return false;}
    stored = value; return true;
  });
  editor.subscribe(value => {ui = value;});
  const pending = {current: 0.5};
  const save = subject('persistPendingOpacity', {pendingOpacityRef: pending, opacitySaveTimeoutRef: {current: 1},
    opacityEditor: editor, panelVisible: {current: true}, reportSaveFailure() {}});
  const first = save(); pending.current = 0.8; const second = save();
  await tick(); firstSave.resolve(); await Promise.all([first, second]);
  assert.equal(ui, 0.8); assert.equal(stored, 0.8);
});
