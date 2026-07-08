import { ServerAPI } from "decky-frontend-lib";

export const clampOpacity = (value: number): number => {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
};

export const parseBooleanSetting = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return fallback;
};

export const parseNumberSetting = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeManualApps = (apps: unknown): string[] => {
  if (!Array.isArray(apps)) return [];

  return Array.from(
    new Set(
      apps
        .map((app) => String(app).trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
};

export const areStringArraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

export const getPluginSetting = async <T,>(
  serverApi: ServerAPI,
  key: string,
  defaults: T
): Promise<T> => {
  const response = await serverApi.callPluginMethod<any, any>("get_settings", { key, defaults });
  return response.success ? response.result : defaults;
};

export const getPluginBooleanSetting = async (
  serverApi: ServerAPI,
  key: string,
  defaults = false
): Promise<boolean> => {
  const value = await getPluginSetting(serverApi, key, defaults);
  return parseBooleanSetting(value, defaults);
};

export const getPluginNumberSetting = async (
  serverApi: ServerAPI,
  key: string,
  defaults: number
): Promise<number> => {
  const value = await getPluginSetting(serverApi, key, defaults);
  return parseNumberSetting(value, defaults);
};

export const setPluginSetting = async (
  serverApi: ServerAPI,
  key: string,
  value: any
) => {
  return await serverApi.callPluginMethod<any, any>("set_settings", { key, value });
};
