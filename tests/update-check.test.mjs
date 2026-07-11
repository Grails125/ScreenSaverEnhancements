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
  assert.doesNotMatch(pluginSource, /callPluginMethod/);
});

test("update checking has localized status and error copy", () => {
  for (const translations of [zh, en]) {
    assert.equal(typeof translations["Check Update"], "string");
    assert.equal(typeof translations["Update Available"], "string");
    assert.equal(typeof translations["Already Latest Version"], "string");
    assert.equal(typeof translations["Update Check Failed"], "string");
  }
});
