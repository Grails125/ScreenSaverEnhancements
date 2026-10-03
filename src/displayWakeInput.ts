import { findModuleExport, GamepadButton } from "@decky/ui";

type Release = () => void;

const unregisterHandle = (handle: any): Release => {
  if (typeof handle === "function") return handle;
  if (typeof handle?.unregister === "function") return () => handle.unregister();
  if (typeof handle?.Unregister === "function") return () => handle.Unregister();
  throw new Error("Display wake subscription did not provide an unregister handle");
};

// These event properties expose CallbackList.Register through getters. Plain
// OnRequestSuspend methods can be Steam's transition handlers, not registrars.
const getEventRegistrar = (store: any, name: string): ((handler: () => void) => any) | null => {
  if (store === null || (typeof store !== "object" && typeof store !== "function")) return null;
  for (let current = store; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (!descriptor) continue;
    if (descriptor.get && typeof store[name] === "function") return store[name].bind(store);
    if (typeof store[name]?.Register === "function") return store[name].Register.bind(store[name]);
    return null;
  }
  return null;
};

export const subscribeDisplayWake = (wake: () => void, closeOnAnyKey: boolean): Release => {
  const steamUI = (window as any).SteamUIStore;
  const navigation = steamUI?.NavigationManager;
  const browser = steamUI?.m_WindowStore?.GamepadUIMainWindowInstance?.BrowserWindow;
  if (typeof navigation?.SetCatchAllGamepadInput !== "function" ||
      typeof browser?.addEventListener !== "function" || typeof browser?.removeEventListener !== "function") {
    throw new Error("Display wake requires the Steam navigation manager and main UI window");
  }

  const isSuspendStore = (value: any) => !!getEventRegistrar(value, "OnRequestSuspend") &&
    !!getEventRegistrar(value, "OnResumeFromSuspend");
  const isSleepManagerService = (value: any) =>
    value?.NotifyRequestSuspendHandler?.name === "SleepManager.NotifyRequestSuspend#1" &&
    typeof value.RegisterForNotifyRequestSuspend === "function" &&
    typeof value.RegisterForNotifyResumeFromSuspend === "function";
  const sleepManager = findModuleExport(isSleepManagerService);
  const globalStore = (window as any).SuspendResumeStore;
  const store = isSuspendStore(globalStore) ? globalStore : findModuleExport(isSuspendStore);
  const system = (window as any).SteamClient?.System;
  const requestSuspend = (isSleepManagerService(sleepManager) ? sleepManager.RegisterForNotifyRequestSuspend.bind(sleepManager) : null) ??
    getEventRegistrar(store, "OnRequestSuspend") ??
    (typeof system?.RegisterForOnSuspendRequest === "function" ? system.RegisterForOnSuspendRequest.bind(system) : null);
  const resumeSuspend = (isSleepManagerService(sleepManager) ? sleepManager.RegisterForNotifyResumeFromSuspend.bind(sleepManager) : null) ??
    getEventRegistrar(store, "OnResumeFromSuspend") ??
    (typeof system?.RegisterForNotifyResumeFromSuspend === "function" ? system.RegisterForNotifyResumeFromSuspend.bind(system) : null);
  if (!requestSuspend || !resumeSuspend) throw new Error("Display wake requires suspend and resume notifications");

  const releases: Release[] = [];
  let released = false;
  let woke = false;
  const armAt = Date.now() + 250;
  const buttons = new Set(Object.values(GamepadButton).filter(value => typeof value === "number" && value !== GamepadButton.INVALID));
  const wakeOnce = () => {
    if (released || woke) return;
    woke = true;
    wake();
  };
  const release = () => {
    if (released) return;
    released = true;
    let failure: unknown;
    for (const unsubscribe of releases.reverse()) {
      try { unsubscribe(); } catch (error) { failure ??= error; }
    }
    releases.length = 0;
    if (failure) throw failure;
  };
  const onInput = (event: Event) => {
    if (released) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (closeOnAnyKey && Date.now() >= armAt) wakeOnce();
  };
  try {
    releases.push(unregisterHandle(navigation.SetCatchAllGamepadInput((button: number, pressed: boolean, repeat: boolean) => {
      if (released) return false;
      if (button === GamepadButton.STEAM_QUICK_MENU) {
        if (pressed && !repeat) wakeOnce();
        return false;
      }
      if (closeOnAnyKey && pressed === true && !repeat && buttons.has(button) && Date.now() >= armAt) wakeOnce();
      return true;
    })));
    for (const type of ["keydown", "pointerdown", "touchstart"]) {
      browser.addEventListener(type, onInput, { capture: true, passive: false });
      releases.push(() => browser.removeEventListener(type, onInput, true));
    }
    // Power transitions belong to Steam; these callbacks only restore display.
    const observePowerTransition = () => { wakeOnce(); return 1; };
    releases.push(unregisterHandle(requestSuspend(observePowerTransition)));
    releases.push(unregisterHandle(resumeSuspend(observePowerTransition)));
  } catch (error) {
    try { release(); } catch { /* Preserve the registration failure. */ }
    throw error;
  }
  return release;
};
