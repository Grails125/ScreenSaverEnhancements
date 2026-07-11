import {
  callable,
  routerHook,
  toaster,
  type RouterHook,
  type Toaster,
} from "@decky/api";

export type PluginMethod =
  | "start_backend"
  | "stop_backend"
  | "is_running"
  | "get_running_processes"
  | "get_inhibit_status"
  | "get_diagnostics"
  | "get_system_power_settings"
  | "get_power_override_state"
  | "begin_power_override"
  | "end_power_override"
  | "wait_for_events"
  | "get_settings"
  | "set_settings"
  | "set_settings_batch";

const PLUGIN_METHOD_ARGUMENT_KEYS: Record<PluginMethod, readonly string[]> = {
  start_backend: [],
  stop_backend: [],
  is_running: [],
  get_running_processes: [],
  get_inhibit_status: [],
  get_diagnostics: [],
  get_system_power_settings: [],
  get_power_override_state: [],
  begin_power_override: ["snapshot"],
  end_power_override: [],
  wait_for_events: ["timeout_seconds"],
  get_settings: ["key", "defaults"],
  set_settings: ["key", "value"],
  set_settings_batch: ["values"],
};

export const getPluginMethodArguments = (
  method: PluginMethod,
  args: Record<string, unknown>,
): unknown[] => PLUGIN_METHOD_ARGUMENT_KEYS[method].map((key) => args[key]);

export type CallableFactory = <Args extends any[] = [], Return = void>(
  route: string,
) => (...args: Args) => Promise<Return>;

export type PluginMethodResponse<Result> = {
  success: boolean;
  result: Result;
};

export interface PluginBackendClient {
  startBackend(): Promise<boolean>;
  stopBackend(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  getRunningProcesses(): Promise<unknown>;
  getInhibitStatus(): Promise<unknown>;
  getDiagnostics(): Promise<unknown>;
  getSystemPowerSettings(): Promise<unknown>;
  getPowerOverrideState(): Promise<unknown>;
  beginPowerOverride(snapshot: Record<string, unknown>): Promise<boolean>;
  endPowerOverride(): Promise<boolean>;
  waitForEvents(timeoutSeconds: number): Promise<unknown[]>;
  getSetting<T>(key: string, defaults: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<boolean>;
  setSettings(values: Record<string, unknown>): Promise<boolean>;

  /** @deprecated Remove after all Stage 2 callers use the typed methods above. */
  callPluginMethod<Args, Result>(
    method: PluginMethod,
    args: Args,
  ): Promise<PluginMethodResponse<Result | any>>;
}

export interface PluginServerApi extends PluginBackendClient {
  routerHook: RouterHook;
  toaster: Toaster;
}

export const createPluginServerApi = (
  callableFactory: CallableFactory = callable,
): PluginServerApi => {
  const startBackend = callableFactory<[], boolean>("start_backend");
  const stopBackend = callableFactory<[], boolean>("stop_backend");
  const isRunning = callableFactory<[], boolean>("is_running");
  const getRunningProcesses = callableFactory<[], unknown>("get_running_processes");
  const getInhibitStatus = callableFactory<[], unknown>("get_inhibit_status");
  const getDiagnostics = callableFactory<[], unknown>("get_diagnostics");
  const getSystemPowerSettings = callableFactory<[], unknown>("get_system_power_settings");
  const getPowerOverrideState = callableFactory<[], unknown>("get_power_override_state");
  const beginPowerOverride = callableFactory<[snapshot: Record<string, unknown>], boolean>("begin_power_override");
  const endPowerOverride = callableFactory<[], boolean>("end_power_override");
  const waitForEvents = callableFactory<[timeoutSeconds: number], unknown[]>("wait_for_events");
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
    async callPluginMethod<Args, Result>(method: PluginMethod, args: Args) {
      try {
        const invoke = callableFactory<any[], Result>(method);
        const result = await invoke(
          ...getPluginMethodArguments(method, args as Record<string, unknown>),
        );
        return { success: true, result };
      } catch (error) {
        return { success: false, result: error as Result };
      }
    },
    routerHook,
    toaster,
  };
};

export const serverApi = createPluginServerApi();
