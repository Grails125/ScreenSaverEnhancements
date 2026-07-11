import { PluginBackendClient } from "./deckyApi";

export const clampOpacity = (value: number): number => {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
};

export const parseBooleanSetting = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
};

export const parseNumberSetting = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeManualApps = (apps: unknown): string[] => {
  if (!Array.isArray(apps)) return [];

  const seen = new Set<string>();
  const normalized = apps.reduce<string[]>((result, app) => {
    const value = String(app).trim();
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
    return result;
  }, []);

  return normalized.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
};

export const areStringArraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

export const getPluginSetting = async <T,>(
  serverApi: PluginBackendClient,
  key: string,
  defaults: T
): Promise<T> => {
  const response = await serverApi.callPluginMethod<any, any>("get_settings", { key, defaults });
  return response.success ? response.result : defaults;
};

export const getPluginBooleanSetting = async (
  serverApi: PluginBackendClient,
  key: string,
  defaults = false
): Promise<boolean> => {
  const value = await getPluginSetting(serverApi, key, defaults);
  return parseBooleanSetting(value, defaults);
};

export const getPluginNumberSetting = async (
  serverApi: PluginBackendClient,
  key: string,
  defaults: number
): Promise<number> => {
  const value = await getPluginSetting(serverApi, key, defaults);
  return parseNumberSetting(value, defaults);
};

export const setPluginSetting = async (
  serverApi: PluginBackendClient,
  key: string,
  value: any
) => {
  return await serverApi.callPluginMethod<any, any>("set_settings", { key, value });
};

export const isPluginSettingSaveSuccessful = (
  response: { success?: boolean; result?: unknown } | null | undefined,
): boolean => response?.success === true && response.result === true;

export const setPluginSettings = async (
  serverApi: PluginBackendClient,
  values: Record<string, unknown>,
) => {
  return await serverApi.callPluginMethod<any, any>("set_settings_batch", { values });
};
