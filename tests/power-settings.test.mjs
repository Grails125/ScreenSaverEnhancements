import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/powerSettings.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const {
  normalizePowerTimeout,
  normalizePowerSettings,
  minutesToSeconds,
  secondsToMinutes,
  shouldStartInhibit,
  shouldApplyPowerSettingsImmediately,
  getForceSuspendWarningDelayMs,
} = module.exports;

test("normalizes power timeouts to whole seconds within the supported range", () => {
  assert.equal(normalizePowerTimeout(0, 300), 0);
  assert.equal(normalizePowerTimeout("125.8", 300), 126);
  assert.equal(normalizePowerTimeout(-1, 300), 0);
  assert.equal(normalizePowerTimeout(9999, 300), 3600);
  assert.equal(normalizePowerTimeout("invalid", 300), 300);
});

test("normalizes power profile values without coupling them to panel visibility", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizePowerSettings({
      batteryDim: 60,
      acDim: 120,
      batterySuspend: 300,
      acSuspend: 600,
      forceSuspend: true,
    }))),
    {
      batteryDim: 60,
      acDim: 120,
      batterySuspend: 300,
      acSuspend: 600,
      forceSuspend: true,
    },
  );
});

test("uses persisted power values and converts displayed minutes", () => {
  const settings = JSON.parse(JSON.stringify(normalizePowerSettings({})));
  assert.deepEqual(Object.keys(settings).sort(), ["acDim", "acSuspend", "batteryDim", "batterySuspend", "forceSuspend"]);
  assert.equal(minutesToSeconds(1), 60);
  assert.equal(minutesToSeconds(60), 3600);
  assert.equal(secondsToMinutes(60), 1);
  assert.equal(secondsToMinutes(300), 5);
});

test("only starts a new inhibit session when no source is already active", () => {
  assert.equal(shouldStartInhibit(false, false), true);
  assert.equal(shouldStartInhibit(true, false), false);
  assert.equal(shouldStartInhibit(false, true), false);
  assert.equal(shouldStartInhibit(true, true), false);
});

test("only applies a changed profile immediately while no source is inhibiting sleep", () => {
  assert.equal(shouldApplyPowerSettingsImmediately(false, false), true);
  assert.equal(shouldApplyPowerSettingsImmediately(true, false), false);
  assert.equal(shouldApplyPowerSettingsImmediately(false, true), false);
  assert.equal(shouldApplyPowerSettingsImmediately(true, true), false);
});

test("schedules the force-suspend warning five seconds before the earliest configured system sleep", () => {
  assert.equal(getForceSuspendWarningDelayMs({
    batteryDim: 60,
    acDim: 60,
    batterySuspend: 360,
    acSuspend: 600,
    forceSuspend: true,
  }), 355_000);

  assert.equal(getForceSuspendWarningDelayMs({
    batteryDim: 60,
    acDim: 60,
    batterySuspend: 600,
    acSuspend: 0,
    forceSuspend: true,
  }), 595_000);

  assert.equal(getForceSuspendWarningDelayMs({
    batteryDim: 60,
    acDim: 60,
    batterySuspend: 0,
    acSuspend: 0,
    forceSuspend: true,
  }), null);
});
