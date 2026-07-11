import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/diagnostics.ts", import.meta.url), "utf8")
  .replace('import { parseSteamPowerSettings, PowerSettings } from "./powerSettings";', 'const parseSteamPowerSettings = () => null;');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { parseDiagnostics } = module.exports;

test("validates and bounds backend diagnostic snapshots", () => {
  assert.equal(parseDiagnostics(null), null);
  const parsed = parseDiagnostics({
    backendRunning: true,
    uptimeSeconds: 999,
    processMonitorMode: "proc_connector",
    recentEvents: [
      { timestamp: 123, type: "backend_started", detail: "ok" },
      { timestamp: 456, detail: "missing type" },
    ],
  });
  assert.equal(parsed.backendRunning, true);
  assert.equal("uptimeSeconds" in parsed, false);
  assert.equal(parsed.processMonitorMode, "proc_connector");
  assert.equal(parsed.recentEvents.length, 1);
  assert.equal(parsed.recentEvents[0].type, "backend_started");
});
