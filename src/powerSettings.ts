export type PowerSettings = {
  batteryDim: number;
  acDim: number;
  batterySuspend: number;
  acSuspend: number;
};

export const DEFAULT_POWER_SETTINGS: PowerSettings = {
  batteryDim: 300,
  acDim: 300,
  batterySuspend: 600,
  acSuspend: 600,
};

export const normalizePowerTimeout = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(3600, Math.max(0, Math.round(parsed)));
};

export const normalizePowerSettings = (value: Record<string, unknown>): PowerSettings => ({
  batteryDim: normalizePowerTimeout(value.batteryDim, DEFAULT_POWER_SETTINGS.batteryDim),
  acDim: normalizePowerTimeout(value.acDim, DEFAULT_POWER_SETTINGS.acDim),
  batterySuspend: normalizePowerTimeout(value.batterySuspend, DEFAULT_POWER_SETTINGS.batterySuspend),
  acSuspend: normalizePowerTimeout(value.acSuspend, DEFAULT_POWER_SETTINGS.acSuspend),
});

export const parseSteamPowerSettings = (value: unknown): PowerSettings | null => {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Record<string, unknown>;
  const settings = typeof result.settings === "object" && result.settings !== null
    ? result.settings as Record<string, unknown>
    : result;

  const readValue = (...keys: string[]) => {
    for (const key of keys) {
      const parsed = Number(settings[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };

  const batteryDim = readValue("battery_idle", "batteryIdle", "batteryDim");
  const acDim = readValue("ac_idle", "acIdle", "acDim");
  const batterySuspend = readValue("battery_suspend", "batterySuspend");
  const acSuspend = readValue("ac_suspend", "acSuspend");
  if ([batteryDim, acDim, batterySuspend, acSuspend].some(item => item === undefined)) {
    return null;
  }

  return normalizePowerSettings({ batteryDim, acDim, batterySuspend, acSuspend });
};

export const shouldSyncSystemPowerSettings = (
  settings: PowerSettings,
  isInhibiting: boolean,
) => !isInhibiting || Object.values(settings).some(timeout => timeout !== 0);

export const minutesToSeconds = (minutes: unknown) => normalizePowerTimeout(
  Number(minutes) * 60,
  0,
);

export const secondsToMinutes = (seconds: unknown) => Math.round(
  normalizePowerTimeout(seconds, 0) / 60,
);

export const shouldApplyPowerSettingsImmediately = (
  backendInhibiting: boolean,
  deckyMusicInhibiting: boolean,
) => !backendInhibiting && !deckyMusicInhibiting;

export const shouldStartInhibit = (
  backendInhibiting: boolean,
  deckyMusicInhibiting: boolean,
) => !backendInhibiting && !deckyMusicInhibiting;
