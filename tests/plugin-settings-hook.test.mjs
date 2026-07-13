import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
const settingsHookSource = readFileSync(new URL("../src/usePluginSettings.ts", import.meta.url), "utf8");

test("keeps shared setting persistence and rollback outside the root panel component", () => {
  assert.match(indexSource, /usePluginSettings/);
  assert.match(settingsHookSource, /setPluginSetting\(serverApi, key, value\)/);
  assert.match(settingsHookSource, /rollback\(\)/);
});
