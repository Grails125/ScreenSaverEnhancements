import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync(new URL("../src/displayWakeInput.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function fixture(service = null) {
  let now = 0;
  let wakes = 0;
  const handlers = [];
  const existing = () => false;
  handlers.push(existing);
  const nav = {
    SetCatchAllGamepadInput(callback) {
      assert.equal(typeof callback, "function", "never clear other handlers with null");
      handlers.push(callback);
      return { Unregister() { handlers.splice(handlers.indexOf(callback), 1); } };
    },
  };
  const listeners = new Map();
  const browser = {
    addEventListener(type, callback, options) {
      assert.equal(options.capture, true);
      assert.equal(options.passive, false);
      listeners.set(type, callback);
    },
    removeEventListener(type, callback, capture) {
      assert.equal(capture, true);
      if (listeners.get(type) === callback) listeners.delete(type);
    },
  };
  const suspendHandlers = [];
  const resumeHandlers = [];
  const register = (list) => (callback) => {
    list.push(callback);
    return { Unregister() { list.splice(list.indexOf(callback), 1); } };
  };
  const suspendStore = {
    get OnRequestSuspend() { return register(suspendHandlers); },
    get OnResumeFromSuspend() { return register(resumeHandlers); },
  };
  const window = {
    SteamUIStore: { NavigationManager: nav, m_WindowStore: { GamepadUIMainWindowInstance: { BrowserWindow: browser } } },
    SuspendResumeStore: suspendStore,
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, window,
    Date: { now: () => now },
    require: () => ({ findModuleExport: (predicate) => service && predicate(service) ? service : null,
      GamepadButton: { INVALID: 0, OK: 1, CANCEL: 2, DIR_UP: 9, LSTICK_TOUCH: 17, STEAM_GUIDE: 27, STEAM_QUICK_MENU: 28 } }),
  });
  return {
    ...module.exports, window, handlers, existing, listeners, browser, suspendHandlers, resumeHandlers,
    arm: () => { now = 251; },
    wake: () => { wakes += 1; },
    get wakes() { return wakes; },
    event(type) {
      const event = { prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; } };
      listeners.get(type)?.(event);
      return event;
    },
  };
}

test("enabled any-key wake waits for activation and ignores invalid, repeat and button-up", () => {
  const f = fixture();
  const release = f.subscribeDisplayWake(f.wake, true);
  const callback = f.handlers.at(-1);
  assert.equal(callback(1, true, false), true);
  assert.equal(f.wakes, 0);
  f.arm();
  for (const [button, down, repeat] of [[0, true, false], [1, false, false], [1, true, true], [99, true, false]]) {
    callback(button, down, repeat);
  }
  assert.equal(f.wakes, 0);
  callback(1, true, false);
  callback(2, true, false);
  assert.equal(f.wakes, 1);
  release();
  assert.deepEqual(f.handlers, [f.existing]);
  assert.equal(callback(1, true, false), false);
});

test("touch, pointer and keyboard wake are consumed and deduplicated", () => {
  for (const first of ["touchstart", "pointerdown", "keydown"]) {
    const f = fixture();
    const release = f.subscribeDisplayWake(f.wake, true);
    f.arm();
    const firstEvent = f.event(first);
    assert.equal(firstEvent.prevented, true);
    assert.equal(firstEvent.stopped, true);
    f.event("pointerdown");
    f.event("touchstart");
    assert.equal(f.wakes, 1);
    release();
    release();
    assert.equal(f.listeners.size, 0);
    assert.equal(f.suspendHandlers.length, 0);
    assert.equal(f.resumeHandlers.length, 0);
  }
});

test("suspend and resume wake immediately without suppressing the native power transition", () => {
  for (const eventName of ["suspendHandlers", "resumeHandlers"]) {
    const f = fixture();
    const release = f.subscribeDisplayWake(f.wake, false);
    const nativeEvent = { preventDefault() { throw new Error("must not intercept system sleep"); } };
    f[eventName][0](nativeEvent);
    assert.equal(f.wakes, 1);
    release();
  }
});

test("missing required input surfaces fail closed without registering partial handlers", () => {
  for (const missing of ["nav", "browser"]) {
    const f = fixture();
    if (missing === "nav") delete f.window.SteamUIStore.NavigationManager;
    else delete f.window.SteamUIStore.m_WindowStore.GamepadUIMainWindowInstance.BrowserWindow;
    assert.throws(() => f.subscribeDisplayWake(f.wake, true));
    assert.deepEqual(f.handlers, [f.existing]);
    assert.equal(f.listeners.size, 0);
  }
});

test("failed event registration rolls back only this subscription", () => {
  const f = fixture();
  Object.defineProperty(f.window.SuspendResumeStore, "OnResumeFromSuspend", {
    get() { return () => { throw new Error("resume registration failed"); }; },
  });
  assert.throws(() => f.subscribeDisplayWake(f.wake, true), /resume registration failed/);
  assert.deepEqual(f.handlers, [f.existing]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.suspendHandlers.length, 0);
});

test("disabled any-key setting swallows ordinary input and QAM wakes while retaining its native action", () => {
  const f = fixture();
  const release = f.subscribeDisplayWake(f.wake, false);
  f.arm();
  const callback = f.handlers.at(-1);
  assert.equal(callback(1, true, false), true);
  assert.equal(callback(9, true, false), true);
  assert.equal(f.event("touchstart").prevented, true);
  assert.equal(f.event("keydown").stopped, true);
  assert.equal(f.wakes, 0);
  assert.equal(callback(28, true, false), false);
  assert.equal(f.wakes, 1);
  release();
});

test("enabled any-key setting accepts directional button presses", () => {
  const f = fixture();
  const release = f.subscribeDisplayWake(f.wake, true);
  f.arm();
  f.handlers.at(-1)(9, true, false);
  assert.equal(f.wakes, 1);
  release();
});

test("plain transition handlers are never called as registrars and native callbacks can provide the notifications", () => {
  const f = fixture();
  f.window.SuspendResumeStore = {
    OnRequestSuspend() { throw new Error("native transition must not be called during registration"); },
    OnResumeFromSuspend() { throw new Error("native transition must not be called during registration"); },
  };
  const callbacks = new Map();
  f.window.SteamClient = { System: {
    RegisterForOnSuspendRequest(callback) {
      callbacks.set("suspend", callback);
      return { Unregister() { callbacks.delete("suspend"); } };
    },
    RegisterForNotifyResumeFromSuspend(callback) {
      callbacks.set("resume", callback);
      return { Unregister() { callbacks.delete("resume"); } };
    },
  } };
  const release = f.subscribeDisplayWake(f.wake, false);
  callbacks.get("suspend")();
  assert.equal(f.wakes, 1);
  release();
  assert.equal(callbacks.size, 0);
});

test("missing power notification registrars fail closed before installing input handlers", () => {
  const f = fixture();
  delete f.window.SuspendResumeStore;
  assert.throws(() => f.subscribeDisplayWake(f.wake, false), /suspend and resume/);
  assert.deepEqual(f.handlers, [f.existing]);
  assert.equal(f.listeners.size, 0);
});

test("protobuf SleepManager notifications observe transitions, return success and unregister only their own callbacks", () => {
  const suspend = [() => "existing suspend observer"];
  const resume = [() => "existing resume observer"];
  const existingSuspend = suspend[0];
  const existingResume = resume[0];
  const service = {
    NotifyRequestSuspendHandler: { name: "SleepManager.NotifyRequestSuspend#1" },
    RegisterForNotifyRequestSuspend(callback) {
      suspend.push(callback);
      return { unregister() { suspend.splice(suspend.indexOf(callback), 1); } };
    },
    RegisterForNotifyResumeFromSuspend(callback) {
      resume.push(callback);
      return { unregister() { resume.splice(resume.indexOf(callback), 1); } };
    },
  };
  const f = fixture(service);
  delete f.window.SuspendResumeStore;
  const release = f.subscribeDisplayWake(f.wake, false);
  assert.equal(suspend.at(-1)({ Body() { throw new Error("observer must not inspect native transition"); } }), 1);
  assert.equal(resume.at(-1)(), 1);
  assert.equal(f.wakes, 1);
  release();
  assert.deepEqual(suspend, [existingSuspend]);
  assert.deepEqual(resume, [existingResume]);
});
