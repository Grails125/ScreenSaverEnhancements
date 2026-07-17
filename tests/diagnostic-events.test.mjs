import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/diagnosticEvents.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const {
  getDiagnosticEventMessage,
  getDiagnosticEventDetailMessage,
  getManualAppInhibitDetail,
  shouldShowLastProcessScan,
} = module.exports;

test("maps every backend diagnostic event to a translatable message", () => {
  assert.equal(getDiagnosticEventMessage("backend_started").key, "backend_started");
  assert.equal(getDiagnosticEventMessage("backend_stopped").key, "backend_stopped");
  assert.equal(getDiagnosticEventMessage("settings_changed").key, "settings_changed");
  assert.equal(getDiagnosticEventMessage("inhibit_state_changed").key, "inhibit_state_changed");
  assert.equal(getDiagnosticEventMessage("process_monitor").key, "process_monitor");
  assert.equal(getDiagnosticEventMessage("decky_music_playback").key, "decky_music_playback");
  assert.equal(getDiagnosticEventMessage("custom_event").fallback, "custom_event");
});

test("maps diagnostic event details to translatable messages", () => {
  assert.equal(getDiagnosticEventDetailMessage("manual_apps").key, "manual_apps");
  assert.equal(getDiagnosticEventDetailMessage("proc_connector").key, "proc_connector");
  assert.equal(getDiagnosticEventDetailMessage("fallback_scan").key, "fallback_scan");
  assert.equal(getDiagnosticEventDetailMessage("decky_music_playing").key, "decky_music_playing");
  assert.equal(getDiagnosticEventDetailMessage("decky_music_stopped").key, "decky_music_stopped");
  assert.equal(getDiagnosticEventDetailMessage("decky_music_audio_temporarily_missing").key, "decky_music_audio_temporarily_missing");
  assert.equal(getDiagnosticEventDetailMessage("custom_detail").fallback, "custom_detail");
});

test("parses manual application inhibit details with the application name", () => {
  const inhibiting = getManualAppInhibitDetail("manual_app_inhibiting:chrome");
  assert.equal(inhibiting?.action, "inhibiting");
  assert.equal(inhibiting?.application, "chrome");
  const released = getManualAppInhibitDetail("manual_app_released:chrome");
  assert.equal(released?.action, "released");
  assert.equal(released?.application, "chrome");
  assert.equal(getManualAppInhibitDetail("manual_app_inhibiting:"), null);
  assert.equal(getManualAppInhibitDetail("decky_music_playing"), null);
});

test("only shows the last scan timestamp when fallback scanning is the active monitor", () => {
  assert.equal(shouldShowLastProcessScan("fallback_scan"), true);
  assert.equal(shouldShowLastProcessScan("proc_connector"), false);
  assert.equal(shouldShowLastProcessScan("stopped"), false);
});

test("provides Chinese translations for every diagnostic event message", () => {
  const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
  const zhCn = JSON.parse(readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"));
  const keys = [
    "backend_started",
    "backend_stopped",
    "settings_changed",
    "inhibit_state_changed",
    "process_monitor",
    "decky_music_playback",
    "decky_music_playing",
    "decky_music_stopped",
    "decky_music_audio_temporarily_missing",
    "Disabled Sleep",
    "Restored Sleep",
    "manual_apps",
    "proc_connector",
    "fallback_scan",
  ];

  for (const key of keys) {
    assert.equal(typeof en[key], "string", `English translation missing for ${key}`);
    assert.equal(typeof zhCn[key], "string", `Chinese translation missing for ${key}`);
  }
});
