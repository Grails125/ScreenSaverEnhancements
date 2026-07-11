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
): PluginServerApi => ({
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
});

export const serverApi = createPluginServerApi();
