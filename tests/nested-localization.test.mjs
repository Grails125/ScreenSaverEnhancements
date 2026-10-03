import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const dictionaries = Object.fromEntries(['en', 'uk', 'zh-cn'].map(lang => [lang, JSON.parse(read(`i18n/${lang}.json`))]));
function load(name, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(read(name), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, ...globals, require: id => {
    if (id.startsWith('./i18n/')) return dictionaries[id.split('/').pop().replace('.json', '')];
    if (id in dependencies) return dependencies[id];
    throw Error(`Unexpected import ${id}`);
  } });
  return module.exports;
}

test('all locales cover current keys and Ukrainian opacity means opacity', () => {
  for (const lang of ['uk', 'zh-cn']) {
    assert.deepEqual(Object.keys(dictionaries.en).filter(key => !(key in dictionaries[lang])), []);
  }
  assert.equal(dictionaries.uk['Black Opacity'], 'Непрозорість');
});

test('locale aliases and missing translation fallback preserve English text', () => {
  const window = { LocalizationManager: { m_rgLocalesToUse: ['uk-UA'] } };
  const i18n = load('i18n.ts', {}, { window }).default;
  assert.equal(i18n.getCurrentLanguage(), 'uk');
  window.LocalizationManager.m_rgLocalesToUse[0] = 'schinese';
  assert.equal(i18n.getCurrentLanguage(), 'zhCn');
  const previous = dictionaries.uk['Screen Off Description'];
  delete dictionaries.uk['Screen Off Description'];
  try {
    assert.equal(i18n.useTranslations('uk')('Screen Off Description'), dictionaries.en['Screen Off Description']);
  } finally {
    if (previous !== undefined) dictionaries.uk['Screen Off Description'] = previous;
  }
});

test('a missing future locale entry still passes strict TypeScript indexing', () => {
  const uk = { ...dictionaries.uk };
  delete uk['Screen Off Description'];
  const source = `declare const window: any;\nconst en = ${JSON.stringify(dictionaries.en)};\n`
    + `const uk = ${JSON.stringify(uk)};\nconst zhCn = ${JSON.stringify(dictionaries['zh-cn'])};\n`
    + read('i18n.ts').replace(/^import .*$/gm, '');
  const filename = fileURLToPath(new URL('../.codex_tmp/i18n-regression.ts', import.meta.url)).replaceAll('\\', '/');
  const options = { strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2020 };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) => name === filename
    ? ts.createSourceFile(name, source, language, true) : getSourceFile(name, language, ...rest);
  const program = ts.createProgram([filename], options, host);
  assert.ok(program.getSourceFile(filename));
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
});

test('nested playback diagnostics retain bounded sources and default older backends', () => {
  const { parseDiagnostics } = load('diagnostics.ts', { './powerSettings': { parseSteamPowerSettings: () => null } });
  const parsed = parseDiagnostics({ nestedMprisActive: true, nestedMprisScanCount: 4,
    nestedMprisLastScanAt: 123, nestedMprisBusCount: 2,
    nestedMprisSources: [{ application: 'mpv', service: 'org.mpris.MediaPlayer2.mpv', reason: 'Playing' }, null] });
  assert.equal(parsed.nestedMprisActive, true);
  assert.equal(parsed.nestedMprisScanCount, 4);
  assert.equal(parsed.nestedMprisLastScanAt, 123);
  assert.equal(parsed.nestedMprisBusCount, 2);
  assert.equal(parsed.nestedMprisSources.length, 1);
  assert.equal(parsed.nestedMprisSources[0].application, 'mpv');
  assert.equal(parseDiagnostics({}).nestedMprisActive, false);
  assert.equal(parseDiagnostics({}).nestedMprisSources.length, 0);
});

test('nested playback event and details use localized messages', () => {
  const { getDiagnosticEventMessage, getDiagnosticEventDetailMessage } = load('diagnosticEvents.ts');
  assert.equal(getDiagnosticEventMessage('nested_mpris_playback').key, 'nested_mpris_playback');
  assert.equal(getDiagnosticEventDetailMessage('nested_mpris_stopped').key, 'nested_mpris_stopped');
  assert.equal(getDiagnosticEventDetailMessage('nested_mpris_sources_changed').key, 'nested_mpris_sources_changed');
});

test('localized app names preserve path matching, Chinese labels and unknown processes', () => {
  const source = read('index.tsx');
  const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['APP_NAMES', 'APP_NAME_KEYS', 'getAppDisplayName']);
  const selected = ast.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(ast))))
    .map(statement => statement.getText(ast)).join('\n');
  const compiled = ts.transpileModule(`${selected}\nglobalThis.getName = getAppDisplayName;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  for (const [lang, expected] of [['zh-cn', 'Microsoft Edge 浏览器'], ['en', 'Microsoft Edge'], ['uk', 'Microsoft Edge']]) {
    const context = { t: key => dictionaries[lang][key] ?? dictionaries.en[key] ?? key };
    vm.runInNewContext(compiled, context);
    assert.equal(context.getName('/opt/microsoft/msedge'), expected);
    assert.equal(context.getName('com.microsoft.msedge'), expected);
    assert.equal(context.getName('unknown process'), 'unknown process');
  }
  assert.equal(dictionaries['zh-cn']['Application Type'], '应用');
  assert.equal(dictionaries['zh-cn']['System Type'], '系统');
  assert.ok(source.includes("t(proc.type === 'app' ? 'Application Type' : 'System Type')"));
  assert.ok(source.includes('{getAppDisplayName(source.application)}'));
});
