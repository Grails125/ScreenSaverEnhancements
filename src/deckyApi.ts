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

type LoaderBackend = {
  call<Args extends any[] = [], Return = void>(route: string, ...args: Args): Promise<Return>;
};

const loaderCallable: CallableFactory = (route) => async (...args) => {
  const loader = (window as unknown as { DeckyBackend?: LoaderBackend }).DeckyBackend;
  if (!loader?.call) throw new Error("Decky Loader API is unavailable");
  return loader.call(route, ...args);
};

export type RunningProcess = { name: string; type: string };
export type InhibitRequest = { cookie: number; application: string; reason: string };
export type NestedMprisSource = {
  application: string;
  service: string;
  reason: string;
};
export type InhibitStatus = {
  manual_apps: string[];
  manual_active_app: string | null;
  manual_active: boolean;
  dbus_requests: InhibitRequest[];
  dbus_active: boolean;
  nested_mpris_sources: NestedMprisSource[];
  nested_mpris_active: boolean;
  is_inhibiting: boolean;
};
export type SettingsChangedKey = "manual_apps";
export type SettingsChangedListener = (key: SettingsChangedKey) => void;
export type InhibitStateChangedListener = () => void;
export type UpdateCheckResult = {
  has_update: boolean;
  current: string;
  latest: string;
  notes: string;
  download_url: string;
  sha256: string;
  error: string;
};
export type UpdateInstallRequest = {
  downloadUrl: string;
  version: string;
  sha256: string;
};

export interface PluginBackendClient {
  startBackend(): Promise<boolean>;
  stopBackend(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  getRunningProcesses(): Promise<RunningProcess[]>;
  getInhibitStatus(): Promise<InhibitStatus>;
  getDiagnostics(): Promise<unknown>;
  clearDiagnosticEvents(): Promise<boolean>;
  getPluginVersion(): Promise<string>;
  checkUpdate(): Promise<UpdateCheckResult>;
  installPluginUpdate(request: UpdateInstallRequest): Promise<void>;
  getSystemPowerSettings(): Promise<unknown>;
  getPowerOverrideState(): Promise<unknown>;
  beginPowerOverride(snapshot: PowerSettings, owner?: string, expectedOwner?: string | null): Promise<boolean>;
  endPowerOverride(owner?: string | null, nextOwner?: string): Promise<boolean>;
  savePowerSettings(profile: PowerSettings, owner: string, expectedOwner: string | null): Promise<boolean>;
  startDisplayWakeGuard(): Promise<string>;
  heartbeatDisplayWakeGuard(token: string): Promise<boolean>;
  stopDisplayWakeGuard(token: string): Promise<boolean>;
  getSetting<T>(key: string, defaults: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<boolean>;
  setSettings(values: Record<string, unknown>): Promise<boolean>;
}

export interface PluginServerApi extends PluginBackendClient {
  routerHook: RouterHook;
  toaster: Toaster;
  subscribeSettingsChanged(listener: SettingsChangedListener): () => void;
  subscribeInhibitStateChanged(listener: InhibitStateChangedListener): () => void;
}

const subscribeSettingsChanged = (listener: SettingsChangedListener) => {
  const eventListener = addEventListener<[key: unknown]>("settings_changed", (key) => {
    if (key === "manual_apps") listener(key);
  });
  return () => removeEventListener("settings_changed", eventListener);
};

const subscribeInhibitStateChanged = (listener: InhibitStateChangedListener) => {
  const eventListener = addEventListener("inhibit_state_changed", listener);
  return () => removeEventListener("inhibit_state_changed", eventListener);
};

export const createPluginServerApi = (
  callableFactory: CallableFactory = callable,
  loaderCallableFactory: CallableFactory = loaderCallable,
): PluginServerApi => {
  const startBackend = callableFactory<[], boolean>("start_backend");
  const stopBackend = callableFactory<[], boolean>("stop_backend");
  const isRunning = callableFactory<[], boolean>("is_running");
  const getRunningProcesses = callableFactory<[], RunningProcess[]>("get_running_processes");
  const getInhibitStatus = callableFactory<[], InhibitStatus>("get_inhibit_status");
  const getDiagnostics = callableFactory<[], unknown>("get_diagnostics");
  const clearDiagnosticEvents = callableFactory<[], boolean>("clear_diagnostic_events");
  const getPluginVersion = callableFactory<[], string>("get_plugin_version");
  const checkUpdate = callableFactory<[], UpdateCheckResult>("check_update");
  const installPlugin = loaderCallableFactory<
    [artifact: string, name: string, version: string, hash: string, installType: number],
    void
  >("utilities/install_plugin");
  const getSystemPowerSettings = callableFactory<[], unknown>("get_system_power_settings");
  const getPowerOverrideState = callableFactory<[], unknown>("get_power_override_state");
  const beginPowerOverrideRpc = callableFactory<[snapshot: PowerSettings, owner?: string, expectedOwner?: string | null], boolean>("begin_power_override");
  const endPowerOverrideRpc = callableFactory<[owner?: string | null, nextOwner?: string], boolean>("end_power_override");
  const savePowerSettings = callableFactory<[profile: PowerSettings, owner: string, expectedOwner: string | null], boolean>("save_power_settings");
  const startDisplayWakeGuard = callableFactory<[], string>("start_display_wake_guard");
  const heartbeatDisplayWakeGuard = callableFactory<[token: string], boolean>("heartbeat_display_wake_guard");
  const stopDisplayWakeGuard = callableFactory<[token: string], boolean>("stop_display_wake_guard");
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
    clearDiagnosticEvents,
    getPluginVersion,
    checkUpdate,
    installPluginUpdate: ({ downloadUrl, version, sha256 }: UpdateInstallRequest) =>
      installPlugin(downloadUrl, "screensaver-enhancements", version, sha256, 2),
    getSystemPowerSettings,
    getPowerOverrideState,
    savePowerSettings,
    beginPowerOverride: (snapshot, owner, expectedOwner) => owner === undefined
      ? beginPowerOverrideRpc(snapshot) : beginPowerOverrideRpc(snapshot, owner, expectedOwner ?? null),
    endPowerOverride: (owner, nextOwner) => owner === undefined
      ? endPowerOverrideRpc() : nextOwner === undefined ? endPowerOverrideRpc(owner) : endPowerOverrideRpc(owner, nextOwner),
    startDisplayWakeGuard,
    heartbeatDisplayWakeGuard,
    stopDisplayWakeGuard,
    getSetting: <T,>(key: string, defaults: T) => getSetting(key, defaults) as Promise<T>,
    setSetting,
    setSettings,
    routerHook,
    toaster,
    subscribeSettingsChanged,
    subscribeInhibitStateChanged,
  };
};

export const serverApi = createPluginServerApi();
