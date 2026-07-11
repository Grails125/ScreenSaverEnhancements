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
  isPluginSettingSaveSuccessful,
  normalizeManualApps,
  parseBooleanSetting,
  parseNumberSetting,
} = module.exports;

test("only treats an RPC save as successful when persistence returns true", () => {
  assert.equal(isPluginSettingSaveSuccessful({ success: true, result: true }), true);
  assert.equal(isPluginSettingSaveSuccessful({ success: true, result: false }), false);
  assert.equal(isPluginSettingSaveSuccessful({ success: false, result: true }), false);
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
