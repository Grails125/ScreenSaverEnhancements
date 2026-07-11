export type PowerSettings = {
  batteryDim: number;
  acDim: number;
  batterySuspend: number;
  acSuspend: number;
  forceSuspend: boolean;
};

export const DEFAULT_POWER_SETTINGS: PowerSettings = {
  batteryDim: 300,
  acDim: 300,
  batterySuspend: 600,
  acSuspend: 600,
  forceSuspend: false,
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
  forceSuspend: value.forceSuspend === true || value.forceSuspend === "true",
});

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

const FORCE_SUSPEND_WARNING_MS = 5_000;

export const getForceSuspendWarningDelayMs = (settings: PowerSettings) => {
  const enabledSuspendTimeouts = [settings.batterySuspend, settings.acSuspend]
    .filter((timeout) => timeout > 0)
    .map((timeout) => timeout * 1_000);
  if (enabledSuspendTimeouts.length === 0) return null;

  return Math.max(0, Math.min(...enabledSuspendTimeouts) - FORCE_SUSPEND_WARNING_MS);
};
