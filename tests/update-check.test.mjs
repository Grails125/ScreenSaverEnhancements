import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pluginSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
const updateHookSource = readFileSync(new URL("../src/usePluginUpdate.ts", import.meta.url), "utf8");
const updateSource = `${pluginSource}\n${updateHookSource}`;
const apiSource = readFileSync(new URL("../src/deckyApi.ts", import.meta.url), "utf8");
const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));

test("update checking uses the V2 typed RPC contract", () => {
  assert.match(apiSource, /getPluginVersion\(\): Promise<string>/);
  assert.match(apiSource, /checkUpdate\(\): Promise<UpdateCheckResult>/);
  assert.match(updateSource, /serverApi\.getPluginVersion\(\)/);
  assert.match(updateSource, /serverApi\.checkUpdate\(\)/);
  assert.match(apiSource, /installPluginUpdate\([^)]*UpdateInstallRequest/);
  assert.match(apiSource, /restartDecky\(\): Promise<void>/);
  assert.match(updateSource, /serverApi\.installPluginUpdate\(/);
  assert.match(updateSource, /serverApi\.restartDecky\(\)/);
  assert.match(updateSource, /serverApi\.getInstalledPluginVersion\(\)/);
  assert.doesNotMatch(updateSource, /callPluginMethod/);
});

test("installation restarts Decky after the target package version reaches disk", () => {
  assert.match(updateHookSource, /installedVersion === latestVersion/);
  assert.match(updateHookSource, /UPDATE_INSTALL_POLL_INTERVAL_MS/);
  assert.match(updateHookSource, /await serverApi\.restartDecky\(\)/);
});

test("update checking has localized status and error copy", () => {
  for (const translations of [zh, en]) {
    assert.equal(typeof translations["Check Update"], "string");
    assert.equal(typeof translations["Update Available"], "string");
    assert.equal(typeof translations["Already Latest Version"], "string");
    assert.equal(typeof translations["Update Check Failed"], "string");
    assert.equal(typeof translations["Download and Install"], "string");
    assert.equal(typeof translations["Installing Update"], "string");
    assert.equal(typeof translations["Update Install Failed"], "string");
  }
});

test("checking or loading the current version never restarts Decky", () => {
  const checkStart = updateHookSource.indexOf("const checkUpdate = async () =>");
  const installStart = updateHookSource.indexOf("const installUpdate = async () =>");
  const loadStart = pluginSource.indexOf("const loadPluginVersion = async () =>");
  const loadEnd = pluginSource.indexOf("const loadPowerSettings = async () =>", loadStart);

  assert.doesNotMatch(updateHookSource.slice(checkStart, installStart), /restartDecky/);
  assert.doesNotMatch(pluginSource.slice(loadStart, loadEnd), /restartDecky/);
});

test("update checking is the final section in the plugin panel", () => {
  const diagnosticsSection = pluginSource.indexOf("<PanelSection title={t('Diagnostics Section')}>");
  const updateSection = pluginSource.indexOf("<PanelSection title={t('Update')}>");

  assert.ok(diagnosticsSection >= 0);
  assert.ok(updateSection > diagnosticsSection);
  assert.equal(pluginSource.indexOf("<PanelSection title=", updateSection + 1), -1);
});
