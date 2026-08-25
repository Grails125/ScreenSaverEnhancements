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
  getInstalledPluginVersion(): Promise<string>;
  checkUpdate(): Promise<UpdateCheckResult>;
  installPluginUpdate(request: UpdateInstallRequest): Promise<void>;
  restartDecky(): Promise<void>;
  getSystemPowerSettings(): Promise<unknown>;
  getPowerOverrideState(): Promise<unknown>;
  beginPowerOverride(snapshot: PowerSettings): Promise<boolean>;
  endPowerOverride(): Promise<boolean>;
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
  const getInstalledPluginVersion = callableFactory<[], string>("get_installed_plugin_version");
  const checkUpdate = callableFactory<[], UpdateCheckResult>("check_update");
  const installPlugin = loaderCallableFactory<
    [artifact: string, name: string, version: string, hash: string, installType: number],
    void
  >("utilities/install_plugin");
  const restartDecky = loaderCallableFactory<[], void>("updater/do_restart");
  const getSystemPowerSettings = callableFactory<[], unknown>("get_system_power_settings");
  const getPowerOverrideState = callableFactory<[], unknown>("get_power_override_state");
  const beginPowerOverride = callableFactory<[snapshot: PowerSettings], boolean>("begin_power_override");
  const endPowerOverride = callableFactory<[], boolean>("end_power_override");
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
    getInstalledPluginVersion,
    checkUpdate,
    installPluginUpdate: ({ downloadUrl, version, sha256 }: UpdateInstallRequest) =>
      installPlugin(downloadUrl, "screensaver-enhancements", version, sha256, 2),
    restartDecky,
    getSystemPowerSettings,
    getPowerOverrideState,
    beginPowerOverride,
    endPowerOverride,
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
