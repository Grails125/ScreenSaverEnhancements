import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/diagnostics.ts", import.meta.url), "utf8")
  .replace('import { parseSteamPowerSettings, PowerSettings } from "./powerSettings";', 'const parseSteamPowerSettings = (value) => value ?? null;');
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
    pushListenerActive: true,
    pushReconnectCount: 2,
    powerOverrideSnapshot: {
      batteryDim: 300,
      acDim: 300,
      batterySuspend: 600,
      acSuspend: 600,
    },
    lastFullSyncAt: 789,
    lastFullSyncSuccessful: false,
    recentEvents: [
      { timestamp: 123, type: "backend_started", detail: "ok" },
      { timestamp: 456, detail: "missing type" },
    ],
  });
  assert.equal(parsed.backendRunning, true);
  assert.equal("uptimeSeconds" in parsed, false);
  assert.equal(parsed.processMonitorMode, "proc_connector");
  assert.equal(parsed.pushListenerActive, true);
  assert.equal(parsed.pushReconnectCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.powerOverrideSnapshot)), {
    batteryDim: 300,
    acDim: 300,
    batterySuspend: 600,
    acSuspend: 600,
  });
  assert.equal(parsed.lastFullSyncAt, 789);
  assert.equal(parsed.lastFullSyncSuccessful, false);
  assert.equal("eventQueueSize" in parsed, false);
  assert.equal("longPollRequests" in parsed, false);
  assert.equal("longPollTimeouts" in parsed, false);
  assert.equal(parsed.recentEvents.length, 1);
  assert.equal(parsed.recentEvents[0].type, "backend_started");
});

test('interface ownership and partial observation remain separate from monitor health', () => {
  const parsed = parseDiagnostics({backendRunning: true,
    dbusServices: [{name: 'org.freedesktop.ScreenSaver', status: 'external', owner: ':1.32', pid: 2130, process: 'steam'}, null, {}],
    dbusObserverStatus: 'partial', observedDbusRequestCount: 2,
    recentEvents: [{type: 'dbus_observed_request', service: 'org.freedesktop.ScreenSaver', application: 'msedge', reason: 'video', cookie: 42}],
  });
  assert.equal(parsed.backendRunning, true);
  assert.equal(parsed.dbusServices.length, 1);
  assert.equal(parsed.dbusServices[0].process, 'steam');
  assert.equal(parsed.dbusObservationComplete, false);
  assert.equal(parsed.observedDbusRequestCount, 2);
  assert.equal(parsed.recentEvents[0].cookie, 42);
});

test('nested polling diagnostics preserve unknown for older backends and reject invalid intervals', () => {
  assert.equal(parseDiagnostics({}).nestedMprisStatus, 'unknown');
  assert.equal(parseDiagnostics({}).nestedMprisPollIntervalSeconds, null);
  for (const value of [null, undefined, '', '10', 0, -2, Infinity, NaN, true]) {
    assert.equal(parseDiagnostics({nestedMprisPollIntervalSeconds: value}).nestedMprisPollIntervalSeconds, null);
  }
  for (const state of ['stopped', 'checking', 'waiting', 'waiting_event', 'watching', 'partial', 'error']) {
    assert.equal(parseDiagnostics({nestedMprisStatus: state}).nestedMprisStatus, state);
  }
  assert.equal(parseDiagnostics({nestedMprisStatus: 'other'}).nestedMprisStatus, 'unknown');
  assert.equal(parseDiagnostics({nestedMprisPollIntervalSeconds: 10}).nestedMprisPollIntervalSeconds, 10);
});
