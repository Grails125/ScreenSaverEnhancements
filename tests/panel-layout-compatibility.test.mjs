import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations]);
const layoutSource = ['toScopedSelector', 'PANEL_LAYOUT_CSS'].map(name => {
  const declaration = declarations.find(node => node.name.getText(ast) === name);
  assert.ok(declaration, `Missing layout declaration: ${name}`);
  return `const ${declaration.getText(ast)};`;
}).join('\n');
const transpile = text => ts.transpileModule(text, {
  compilerOptions: {target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React},
}).outputText;
const layoutCode = transpile(`${layoutSource}\n({toScopedSelector, css: PANEL_LAYOUT_CSS});`);
const classes = {PanelSection: 'section_hash', PanelSectionRow: 'row_hash', Title: 'title_hash'};
const layout = staticClasses => vm.runInNewContext(layoutCode, {staticClasses});

let titleExpression;
function findTitle(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'titleView') {
    titleExpression = node.initializer.getText(ast);
  }
  ts.forEachChild(node, findTitle);
}
findTitle(ast);
assert.ok(titleExpression, 'Missing plugin title view');
const titleCode = transpile(`const title = ${titleExpression}; title;`);
const title = staticClasses => vm.runInNewContext(titleCode, {
  staticClasses,
  t: () => 'Localized plugin name',
  React: {createElement: (type, props, ...children) => ({type, props, children})},
});

test('panel selectors preserve single and compound class matching', () => {
  const {toScopedSelector} = layout(classes);
  assert.equal(toScopedSelector('section_hash'), '.section_hash');
  assert.equal(toScopedSelector('section_hash extra_hash'), '.section_hash.extra_hash');
  assert.equal(toScopedSelector('  section_hash   extra_hash  '), '.section_hash.extra_hash');
});

test('panel selectors ignore non-string class values', () => {
  const {toScopedSelector} = layout(classes);
  for (const value of [undefined, null, false, 0, 42, {}, [], ['section_hash']]) {
    assert.equal(toScopedSelector(value), '');
  }
});

test('panel selectors handle empty and whitespace-separated class values', () => {
  const {toScopedSelector} = layout(classes);
  assert.equal(toScopedSelector(''), '');
  assert.equal(toScopedSelector(' \t\r\n '), '');
  assert.equal(toScopedSelector(' section_hash\textra_hash\nthird_hash '),
    '.section_hash.extra_hash.third_hash');
});

test('normal panel CSS retains both scoped margin overrides', () => {
  const {css} = layout(classes);
  assert.match(css, /\.sse-panel-root\s+\.section_hash\s*\{/);
  assert.match(css, /\.sse-panel-root\s+\.row_hash\s*\{/);
  assert.equal(css.replace(/\s/g, ''), `
    .sse-panel-root .section_hash {margin-left:0!important;margin-right:0!important;}
    .sse-panel-root .row_hash {margin-left:0!important;margin-right:0!important;}
  `.replace(/\s/g, ''));
});

test('missing panel fields omit only their rule, never target the root container', () => {
  for (const key of ['PanelSection', 'PanelSectionRow']) {
    const {css} = layout({[key]: classes[key]});
    assert.match(css, new RegExp(`\\.sse-panel-root\\s+\\.${classes[key]}\\s*\\{`));
    assert.equal(css.replace(/\s/g, ''),
      `.sse-panel-root.${classes[key]}{margin-left:0!important;margin-right:0!important;}`);
    assert.doesNotMatch(css, /\.sse-panel-root\s*\{/);
  }
});

test('missing class maps and invalid or blank fields produce no panel overrides', () => {
  for (const value of [undefined, null, {},
    {PanelSection: null, PanelSectionRow: false},
    {PanelSection: 42, PanelSectionRow: []},
    {PanelSection: '', PanelSectionRow: ' \t\n '}]) {
    assert.equal(layout(value).css.trim(), '');
  }
});

test('plugin title keeps its localized text and existing class', () => {
  const element = title(classes);
  assert.equal(element.type, 'div');
  assert.equal(element.props.className, 'title_hash');
  assert.deepEqual(element.children, ['Localized plugin name']);
});

test('plugin title renders without a class when the class map or title is missing', () => {
  for (const value of [undefined, null, {}]) {
    const element = title(value);
    assert.equal(element.type, 'div');
    assert.equal(element.props.className, undefined);
    assert.deepEqual(element.children, ['Localized plugin name']);
  }
});
