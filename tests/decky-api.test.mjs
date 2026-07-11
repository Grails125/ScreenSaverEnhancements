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

test("preserves the legacy success envelope over modern callable results", async () => {
  const calls = [];
  const { createPluginServerApi } = loadDeckyApi(
    (route) => async (...args) => {
      calls.push({ route, args });
      return { active: true };
    },
  );
  const serverApi = createPluginServerApi();

  const response = await serverApi.callPluginMethod(
    "get_power_override_state",
    {},
  );

  assert.deepEqual(calls, [{ route: "get_power_override_state", args: [] }]);
  assert.equal(response.success, true);
  assert.equal(response.result.active, true);
});

test("converts modern callable rejections to the legacy failure envelope", async () => {
  const failure = new Error("backend unavailable");
  const { createPluginServerApi } = loadDeckyApi(
    () => async () => {
      throw failure;
    },
  );
  const serverApi = createPluginServerApi();

  const response = await serverApi.callPluginMethod("get_diagnostics", {});

  assert.equal(response.success, false);
  assert.equal(response.result, failure);
});
