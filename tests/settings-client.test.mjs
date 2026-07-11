import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/settingsClient.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const {
  getPluginSetting,
  isPluginSettingSaveSuccessful,
  normalizeManualApps,
  parseBooleanSetting,
  parseNumberSetting,
  setPluginSetting,
  setPluginSettings,
} = module.exports;

test("only treats an RPC save as successful when persistence returns true", () => {
  assert.equal(isPluginSettingSaveSuccessful(true), true);
  assert.equal(isPluginSettingSaveSuccessful(false), false);
  assert.equal(isPluginSettingSaveSuccessful({ success: true, result: true }), false);
});

test("uses direct setting RPC results and preserves read fallbacks", async () => {
  const serverApi = {
    async getSetting(key, defaults) {
      if (key === "missing") throw new Error("backend unavailable");
      return key === "manual_apps" ? ["mpv"] : defaults;
    },
    async setSetting() {
      return true;
    },
    async setSettings() {
      return false;
    },
  };

  assert.deepEqual(Array.from(await getPluginSetting(serverApi, "manual_apps", [])), ["mpv"]);
  assert.equal(await getPluginSetting(serverApi, "missing", "fallback"), "fallback");
  assert.equal(await setPluginSetting(serverApi, "show_notify", true), true);
  assert.equal(await setPluginSettings(serverApi, { show_notify: true }), false);
});

test("converts setting write rejections to failed persistence results", async () => {
  const serverApi = {
    async setSetting() {
      throw new Error("backend unavailable");
    },
    async setSettings() {
      throw new Error("backend unavailable");
    },
  };

  assert.equal(await setPluginSetting(serverApi, "show_notify", true), false);
  assert.equal(await setPluginSettings(serverApi, { show_notify: true }), false);
});

test("normalizes manual app rules without discarding an empty list", () => {
  assert.deepEqual(Array.from(normalizeManualApps([])), []);
  assert.deepEqual(
    Array.from(normalizeManualApps([" MPV ", "chrome", "mpv", "", "chrome"])),
    ["chrome", "MPV"],
  );
});

test("parses persisted boolean and number settings with safe fallbacks", () => {
  assert.equal(parseBooleanSetting("TRUE"), true);
  assert.equal(parseBooleanSetting("invalid", true), true);
  assert.equal(parseNumberSetting("0.75", 1), 0.75);
  assert.equal(parseNumberSetting("invalid", 1), 1);
});
