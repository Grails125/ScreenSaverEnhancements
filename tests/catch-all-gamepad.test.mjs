import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(
  new URL("../src/useCatchAllGamepad.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const loadHook = (navManager) => {
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    window: { SteamUIStore: { NavigationManager: navManager } },
    require: (name) => {
      if (name !== "react") throw new Error(`Unexpected module: ${name}`);
      return {
        useCallback: (callback) => callback,
        useRef: (initialValue) => ({ current: initialValue }),
      };
    },
  });
  return module.exports.useCatchAllGamepad();
};

const handler = () => {};

test("releases Steam's uppercase Unregister object handle exactly once", () => {
  let unregisterCalls = 0;
  const registrations = [];
  const navManager = {
    SetCatchAllGamepadInput(callback) {
      registrations.push(callback);
      return { Unregister: () => { unregisterCalls += 1; } };
    },
  };
  const { subscribe, release } = loadHook(navManager);

  subscribe(handler);
  release();
  release();

  assert.equal(unregisterCalls, 1);
  assert.deepEqual(registrations, [handler]);
});

test("releases a lowercase unregister object handle", () => {
  let unregisterCalls = 0;
  const navManager = {
    SetCatchAllGamepadInput() {
      return { unregister: () => { unregisterCalls += 1; } };
    },
  };
  const { subscribe, release } = loadHook(navManager);

  subscribe(handler);
  release();

  assert.equal(unregisterCalls, 1);
});

test("keeps function release handles compatible", () => {
  let releaseCalls = 0;
  const navManager = {
    SetCatchAllGamepadInput() {
      return () => { releaseCalls += 1; };
    },
  };
  const { subscribe, release } = loadHook(navManager);

  subscribe(handler);
  release();

  assert.equal(releaseCalls, 1);
});

test("does not register null when Steam provides no release handle", () => {
  const registrations = [];
  const navManager = {
    SetCatchAllGamepadInput(callback) {
      registrations.push(callback);
      return undefined;
    },
  };
  const { subscribe, release } = loadHook(navManager);

  subscribe(handler);
  release();

  assert.deepEqual(registrations, [handler]);
});
