import {
  addEventListener,
  callable,
  removeEventListener,
  routerHook,
  toaster,
  type RouterHook,
  type Toaster,
} from "@decky/api";
import type { PowerSettings } from "./powerSettings";

export type CallableFactory = <Args extends any[] = [], Return = void>(
  route: string,
) => (...args: Args) => Promise<Return>;

export type RunningProcess = { name: string; type: string };
export type InhibitRequest = { cookie: number; application: string; reason: string };
export type InhibitStatus = {
  manual_apps: string[];
  manual_active_app: string | null;
  manual_active: boolean;
  dbus_requests: InhibitRequest[];
  dbus_active: boolean;
  is_inhibiting: boolean;
};
export type PluginEvent =
  | { type: "SettingsChanged"; key: string }
  | { type: "Inhibit"; application?: string }
  | { type: "UnInhibit"; reason?: "monitor_stopped" };
export type SettingsChangedKey = "manual_apps";
export type SettingsChangedListener = (key: SettingsChangedKey) => void;

export interface PluginBackendClient {
  startBackend(): Promise<boolean>;
  stopBackend(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  getRunningProcesses(): Promise<RunningProcess[]>;
  getInhibitStatus(): Promise<InhibitStatus>;
  getDiagnostics(): Promise<unknown>;
  getSystemPowerSettings(): Promise<unknown>;
  getPowerOverrideState(): Promise<unknown>;
  beginPowerOverride(snapshot: PowerSettings): Promise<boolean>;
  endPowerOverride(): Promise<boolean>;
  waitForEvents(timeoutSeconds: number): Promise<PluginEvent[]>;
  getSetting<T>(key: string, defaults: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<boolean>;
  setSettings(values: Record<string, unknown>): Promise<boolean>;
}

export interface PluginServerApi extends PluginBackendClient {
  routerHook: RouterHook;
  toaster: Toaster;
  subscribeSettingsChanged(listener: SettingsChangedListener): () => void;
}

const subscribeSettingsChanged = (listener: SettingsChangedListener) => {
  const eventListener = addEventListener<[key: unknown]>("settings_changed", (key) => {
    if (key === "manual_apps") listener(key);
  });
  return () => removeEventListener("settings_changed", eventListener);
};

export const createPluginServerApi = (
  callableFactory: CallableFactory = callable,
): PluginServerApi => {
  const startBackend = callableFactory<[], boolean>("start_backend");
  const stopBackend = callableFactory<[], boolean>("stop_backend");
  const isRunning = callableFactory<[], boolean>("is_running");
  const getRunningProcesses = callableFactory<[], RunningProcess[]>("get_running_processes");
  const getInhibitStatus = callableFactory<[], InhibitStatus>("get_inhibit_status");
  const getDiagnostics = callableFactory<[], unknown>("get_diagnostics");
  const getSystemPowerSettings = callableFactory<[], unknown>("get_system_power_settings");
  const getPowerOverrideState = callableFactory<[], unknown>("get_power_override_state");
  const beginPowerOverride = callableFactory<[snapshot: PowerSettings], boolean>("begin_power_override");
  const endPowerOverride = callableFactory<[], boolean>("end_power_override");
  const waitForEvents = callableFactory<[timeoutSeconds: number], PluginEvent[]>("wait_for_events");
  const getSetting = callableFactory<[key: string, defaults: unknown], unknown>("get_settings");
  const setSetting = callableFactory<[key: string, value: unknown], boolean>("set_settings");
  const setSettings = callableFactory<[values: Record<string, unknown>], boolean>("set_settings_batch");

  return {
    startBackend,
    stopBackend,
    isRunning,
    getRunningProcesses,
    getInhibitStatus,
    getDiagnostics,
    getSystemPowerSettings,
    getPowerOverrideState,
    beginPowerOverride,
    endPowerOverride,
    waitForEvents,
    getSetting: <T,>(key: string, defaults: T) => getSetting(key, defaults) as Promise<T>,
    setSetting,
    setSettings,
    routerHook,
    toaster,
    subscribeSettingsChanged,
  };
};

export const serverApi = createPluginServerApi();
