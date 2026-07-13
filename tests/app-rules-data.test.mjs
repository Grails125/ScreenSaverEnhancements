import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
const appRulesHookSource = readFileSync(new URL("../src/useAppRulesData.ts", import.meta.url), "utf8");

test("keeps application-rule process and inhibit data outside the root panel component", () => {
  assert.match(indexSource, /useAppRulesData/);
  assert.match(appRulesHookSource, /serverApi\.getRunningProcesses\(\)/);
  assert.match(appRulesHookSource, /serverApi\.getInhibitStatus\(\)/);
  assert.match(appRulesHookSource, /const refreshAppMenuData = async/);
});
