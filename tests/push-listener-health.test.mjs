import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(
  new URL("../src/pushListenerHealth.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const module = { exports: {} };
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
});

const { createPushListenerHealth } = module.exports;

test("counts successful listener restoration but not the initial subscription", () => {
  const health = createPushListenerHealth();

  health.markConnected();
  assert.deepEqual({ ...health.snapshot() }, {
    pushListenerActive: true,
    pushReconnectCount: 0,
  });

  health.markDisconnected();
  health.markConnected();
  assert.deepEqual({ ...health.snapshot() }, {
    pushListenerActive: true,
    pushReconnectCount: 1,
  });
});

test("does not count repeated connected notifications without a disconnect", () => {
  const health = createPushListenerHealth();

  health.markConnected();
  health.markConnected();

  assert.equal(health.snapshot().pushReconnectCount, 0);
});
