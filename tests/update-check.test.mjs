import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pluginSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/deckyApi.ts", import.meta.url), "utf8");
const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh-cn.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));

test("update checking uses the V2 typed RPC contract", () => {
  assert.match(apiSource, /getPluginVersion\(\): Promise<string>/);
  assert.match(apiSource, /checkUpdate\(\): Promise<UpdateCheckResult>/);
  assert.match(pluginSource, /serverApi\.getPluginVersion\(\)/);
  assert.match(pluginSource, /serverApi\.checkUpdate\(\)/);
  assert.match(apiSource, /installPluginUpdate\([^)]*UpdateInstallRequest/);
  assert.match(apiSource, /restartDecky\(\): Promise<void>/);
  assert.match(pluginSource, /serverApi\.installPluginUpdate\(/);
  assert.match(pluginSource, /serverApi\.restartDecky\(\)/);
  assert.match(pluginSource, /serverApi\.getInstalledPluginVersion\(\)/);
  assert.doesNotMatch(pluginSource, /callPluginMethod/);
});

test("installation restarts Decky after the target package version reaches disk", () => {
  assert.match(pluginSource, /installedVersion === latestVersion/);
  assert.match(pluginSource, /UPDATE_INSTALL_POLL_INTERVAL_MS/);
  assert.match(pluginSource, /await serverApi\.restartDecky\(\)/);
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

test("update installation persists the target version until the reloaded plugin restarts Decky", () => {
  assert.match(pluginSource, /UPDATE_RESTART_TARGET_KEY/);
  assert.match(pluginSource, /localStorage\.setItem\(UPDATE_RESTART_TARGET_KEY, JSON\.stringify\(\{/);
  assert.match(pluginSource, /version: latestVersion/);
  assert.match(pluginSource, /version === restartTarget/);
  assert.match(pluginSource, /localStorage\.removeItem\(UPDATE_RESTART_TARGET_KEY\)/);
});

test("update checking is the final section in the plugin panel", () => {
  const diagnosticsSection = pluginSource.indexOf("<PanelSection title={t('Diagnostics Section')}>");
  const updateSection = pluginSource.indexOf("<PanelSection title={t('Update')}>");

  assert.ok(diagnosticsSection >= 0);
  assert.ok(updateSection > diagnosticsSection);
  assert.equal(pluginSource.indexOf("<PanelSection title=", updateSection + 1), -1);
});
