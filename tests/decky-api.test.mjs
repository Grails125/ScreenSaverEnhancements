import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/deckyApi.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const loadDeckyApi = (callable) => {
  const module = { exports: {} };
  const deckyApiModule = {
    callable,
    routerHook: { addGlobalComponent() {}, removeGlobalComponent() {} },
    toaster: { toast() {} },
  };

  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(id) {
      if (id === "@decky/api") return deckyApiModule;
      throw new Error(`Unexpected import: ${id}`);
    },
  });

  return module.exports;
};

test("maps legacy argument objects to modern positional RPC arguments", () => {
  const { getPluginMethodArguments } = loadDeckyApi(() => async () => undefined);

  assert.deepEqual(
    Array.from(getPluginMethodArguments("get_settings", { key: "manual_apps", defaults: [] })),
    ["manual_apps", []],
  );
  assert.deepEqual(
    Array.from(getPluginMethodArguments("begin_power_override", { snapshot: { batteryDim: 60 } })),
    [{ batteryDim: 60 }],
  );
  assert.deepEqual(Array.from(getPluginMethodArguments("is_running", {})), []);
});

test("exposes typed RPC methods with positional callable arguments", async () => {
  const calls = [];
  const { createPluginServerApi } = loadDeckyApi(
    (route) => async (...args) => {
      calls.push({ route, args });
      return { active: true };
    },
  );
  const serverApi = createPluginServerApi();

  const response = await serverApi.getPowerOverrideState();
  await serverApi.getSetting("manual_apps", []);
  await serverApi.beginPowerOverride({ batteryDim: 60 });

  assert.deepEqual(calls, [
    { route: "get_power_override_state", args: [] },
    { route: "get_settings", args: ["manual_apps", []] },
    { route: "begin_power_override", args: [{ batteryDim: 60 }] },
  ]);
  assert.equal(response.active, true);
});

test("propagates callable rejections to feature boundaries", async () => {
  const failure = new Error("backend unavailable");
  const { createPluginServerApi } = loadDeckyApi(
    () => async () => {
      throw failure;
    },
  );
  const serverApi = createPluginServerApi();

  await assert.rejects(serverApi.getDiagnostics(), failure);
});
