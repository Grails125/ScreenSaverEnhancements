import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const navigationSource = readFileSync(new URL("../src/panelNavigation.ts", import.meta.url), "utf8");
const navigationModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(navigationSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: navigationModule, exports: navigationModule.exports });
const { resetSecondaryPageScroll } = navigationModule.exports;

test("resets every scrollable ancestor before opening a secondary page", () => {
  const root = { parentElement: null, scrollHeight: 900, clientHeight: 400, scrollTop: 240 };
  const section = { parentElement: root, scrollHeight: 300, clientHeight: 300, scrollTop: 80 };
  const trigger = { parentElement: section, scrollHeight: 40, clientHeight: 40, scrollTop: 0 };

  resetSecondaryPageScroll(trigger);

  assert.equal(root.scrollTop, 0);
  assert.equal(section.scrollTop, 80);
});

test("uses one sleep-inhibition notification path for every application source", () => {
  const indexSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");

  assert.match(indexSource, /const notifyInhibitState = \(application: string \| undefined, active: boolean\)/);
  assert.match(indexSource, /notifyInhibitState\(application, true\)/);
  assert.match(indexSource, /notifyInhibitState\(undefined, false\)/);
  assert.doesNotMatch(indexSource, /notify\(DECKY_MUSIC_APP,/);
  assert.match(indexSource, /openAppMenu\(event\.currentTarget\)/);
  assert.match(indexSource, /openDiagnostics\(event\.currentTarget\)/);
});

test("recognizes the preserved Decky Music rule name as the playback source", () => {
  const indexSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");

  assert.match(indexSource, /replace\(\/\[\\s_-\]\/g, ""\)/);
  assert.match(indexSource, /manual_active_app \|\| DECKY_MUSIC_APP/);
});
