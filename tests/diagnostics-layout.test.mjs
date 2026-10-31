import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ['PANEL_STYLES', 'DiagnosticGroup', 'DiagnosticRow', 'DiagnosticsPage',
  'formatNestedStatus', 'formatDbusObserverStatus'];
function fixture(overrides = {}) {
  const body = [];
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declarations.includes(declaration.name.getText(ast))) body.push(`const ${declaration.getText(ast)};`);
    }
  }
  const state = new Map(); let cursor = 0;
  const context = vm.createContext({
    React: {createElement: (type, props, ...children) => ({type, props: {...props, children}})},
    useState: initial => {const id = cursor++; if (!state.has(id)) state.set(id, initial);
      return [state.get(id), value => state.set(id, typeof value === 'function' ? value(state.get(id)) : value)];},
    t: key => key, getAppDisplayName: value => value,
    formatDiagnosticTime: value => value === null ? 'Not Available' : String(value),
    formatProcessMonitorMode: value => value, shouldShowLastProcessScan: () => true,
    formatDiagnosticEventType: value => value, formatDbusDiagnosticEvent: () => undefined,
    formatDiagnosticEventDetail: value => value,
    ...Object.fromEntries(['PanelLayout', 'PanelSection', 'PanelSectionRow', 'Focusable', 'MonitorStatusRow',
      'SecondaryPageBackButton', 'RefreshButton', 'ButtonItem', 'RiInformationLine', 'RiDeleteBinLine',
      'RiArrowDownSFill', 'RiArrowUpSFill'].map(key => [key, key])), ...overrides,
  });
  const code = ts.transpileModule(body.join('\n'), {fileName: 'subject.tsx',
    compilerOptions: {target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React}}).outputText;
  vm.runInContext(`${code}\nthis.subject={${declarations.filter(name => source.includes(`const ${name}`)).join(',')}}`, context);
  return {subject: context.subject, render: (name, props) => {cursor = 0; return context.subject[name](props);}};
}
function flatten(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(flatten)];
}
const data = {backendRunning: true, processMonitorMode: 'proc_connector', manualRuleCount: 8,
  manualActiveApp: 'duanjuhui.exe', powerOverrideActive: true,
  dbusServices: [{name:'org.freedesktop.ScreenSaver', status:'external', process:'steam', owner:':1.32', pid:2130}],
  dbusObserverStatus:'partial', observedDbusRequestCount:0, dbusRequestCount:0,
  nestedMprisActive:false, nestedMprisSources:[], nestedMprisStatus:'waiting', nestedMprisPollIntervalSeconds:10,
  nestedMprisScanCount:49, nestedMprisBusCount:0, nestedMprisLastScanAt:123,
  powerOverrideSnapshot:null, systemPowerSettings:null, recentEvents:[]};

test('diagnostic sections start collapsed and toggle accessibly without discarding child state', () => {
  const f = fixture();
  assert.equal(typeof f.subject.DiagnosticGroup, 'function');
  const props = {id:'test', title:'Nested', summary:'Waiting', children:'details'};
  let nodes = flatten(f.render('DiagnosticGroup', props));
  let trigger = nodes.find(n => n.props['aria-expanded'] !== undefined);
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(trigger.props.role, 'button');
  let region = nodes.find(n => n.props.id === trigger.props['aria-controls']);
  assert.equal(region.props.hidden, true);
  trigger.props.onClick();
  nodes = flatten(f.render('DiagnosticGroup', props));
  trigger = nodes.find(n => n.props['aria-expanded'] !== undefined);
  assert.equal(trigger.props['aria-expanded'], true);
  region = nodes.find(n => n.props.id === trigger.props['aria-controls']);
  assert.equal(region.props.hidden, false);
  let prevented = false;
  trigger.props.onKeyDown({key:' ', repeat:false, preventDefault(){prevented=true;}, stopPropagation(){}});
  assert.equal(prevented, true);
  nodes = flatten(f.render('DiagnosticGroup', props));
  assert.equal(nodes.find(n => n.props['aria-expanded'] !== undefined).props['aria-expanded'], false);
});

test('new diagnostic fields are grouped rather than filling the overview', () => {
  const f = fixture();
  const nodes = flatten(f.render('DiagnosticsPage', {diagnostics:data}));
  const groups = nodes.filter(n => n.type === f.subject.DiagnosticGroup);
  assert.ok(groups.some(n => n.props.id === 'dbus'));
  assert.ok(groups.some(n => n.props.id === 'nested'));
  assert.ok(groups.some(n => n.props.id === 'technical'));
  const nested = groups.find(n => n.props.id === 'nested');
  const interval = flatten(nested).find(n => n.props.label === 'Nested Poll Interval');
  assert.ok(interval, 'interval is included in the rendered detail group');
  assert.match(JSON.stringify(interval.props.value), /10/);
});

test('stopped and unknown detectors never masquerade as healthy empty sessions', () => {
  const f = fixture();
  assert.equal(typeof f.subject.formatNestedStatus, 'function');
  assert.equal(f.subject.formatNestedStatus({...data, backendRunning:false}), 'Stopped');
  assert.equal(f.subject.formatNestedStatus({...data, nestedMprisStatus:'unknown'}), 'Not Available');
  assert.equal(f.subject.formatNestedStatus({...data, nestedMprisStatus:'error'}), 'Nested Detection Error');
  assert.equal(f.subject.formatNestedStatus({...data, nestedMprisStatus:'waiting_event'}), 'Nested Waiting For Event');
  assert.equal(f.subject.formatDbusObserverStatus('unavailable'), 'D-Bus Observer Unavailable');
  assert.equal(f.subject.formatDbusObserverStatus('unexpected'), 'Not Available');
});
