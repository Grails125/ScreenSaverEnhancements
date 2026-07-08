import { ServerAPI } from "decky-frontend-lib";

export const clampOpacity = (value: number): number => {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
};

export const parseBooleanSetting = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
};

export const getPluginSetting = async <T,>(
  serverApi: ServerAPI,
  key: string,
  defaults: T
): Promise<T> => {
  const response = await serverApi.callPluginMethod<any, any>("get_settings", { key, defaults });
  return response.success ? response.result : defaults;
};

export const setPluginSetting = async (
  serverApi: ServerAPI,
  key: string,
  value: any
) => {
  return await serverApi.callPluginMethod<any, any>("set_settings", { key, value });
};
