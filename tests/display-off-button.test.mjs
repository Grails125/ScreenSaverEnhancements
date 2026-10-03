import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const code = ts.transpileModule(readFileSync(new URL('../src/displayOffSection.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function fixture(mode) {
  let activations = 0;
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  // Public Decky components remain opaque nodes; inspect the actual props the
  // plugin supplies, without reproducing Decky's focus implementation.
  const ui = Object.fromEntries(['ButtonItem', 'DialogButton', 'Field', 'PanelSection', 'PanelSectionRow']
    .map(name => [name, name]));
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    if (name === '@decky/ui') return ui;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useState: initial => [initial, () => {}], useEffect() {}, useId: () => 'description-test' };
    if (name === './i18n') return { getCurrentLanguage: () => 'en', useTranslations: () => value => value };
    if (name === './state') return {};
    throw Error(`Unexpected import: ${name}`);
  } });
  const tree = module.exports.DisplayOffSection({
    state: { GetState: () => mode }, onActivate: async () => { activations++; },
  });
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.props?.onClick === 'function') return node;
    for (const child of [node.props?.children].flat()) {
      const found = find(child); if (found) return found;
    }
    return null;
  };
  const button = find(tree);
  assert.ok(button, 'Screen-off action must expose click activation');
  return { button, activations: () => activations,
    // A disabled native/Decky button does not dispatch its click activation.
    click: async () => { if (!button.props.disabled) await button.props.onClick(); } };
}

test('touch-compatible mouse down blocks default and parent focus without activating', async () => {
  const f = fixture(0);
  let defaultPrevented = false, propagationStopped = false;
  assert.equal(typeof f.button.props.onMouseDown, 'function');
  f.button.props.onMouseDown({
    preventDefault() { defaultPrevented = true; },
    stopPropagation() { propagationStopped = true; },
  });
  assert.equal(defaultPrevented, true, 'default mouse focus can scroll the button before click');
  assert.equal(propagationStopped, true, 'the field parent must not focus and scroll the button');
  assert.equal(f.activations(), 0);
  await f.click(); assert.equal(f.activations(), 1);
});

test('controller click remains enabled only in idle mode', async () => {
  for (const mode of [0, 1, 2, 3]) {
    const f = fixture(mode);
    assert.equal(f.button.props.disabled, mode !== 0);
    assert.equal(typeof f.button.props.onClick, 'function');
    await f.click(); assert.equal(f.activations(), mode === 0 ? 1 : 0);
  }
});
