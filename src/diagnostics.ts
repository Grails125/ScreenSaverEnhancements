import { parseSteamPowerSettings, PowerSettings } from "./powerSettings";

export type DiagnosticEvent = {
  timestamp: number;
  type: string;
  detail?: string;
};

export type Diagnostics = {
  timestamp: number;
  backendRunning: boolean;
  processMonitorMode: string;
  processScanCount: number;
  lastProcessScanAt: number | null;
  lastProcessEventAt: number | null;
  manualRuleCount: number;
  manualActiveApp: string | null;
  dbusRequestCount: number;
  pushListenerActive: boolean;
  pushReconnectCount: number;
  lastFullSyncAt: number | null;
  lastFullSyncSuccessful: boolean | null;
  powerOverrideActive: boolean;
  powerOverrideSnapshot: PowerSettings | null;
  systemPowerSettings: PowerSettings | null;
  recentEvents: DiagnosticEvent[];
};

const finiteNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nullableTimestamp = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const parsed = finiteNumber(value, -1);
  return parsed >= 0 ? parsed : null;
};

export const parseDiagnostics = (value: unknown): Diagnostics | null => {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const recentEvents = Array.isArray(source.recentEvents)
    ? source.recentEvents.slice(0, 40).flatMap((item): DiagnosticEvent[] => {
      if (!item || typeof item !== "object") return [];
      const event = item as Record<string, unknown>;
      if (typeof event.type !== "string") return [];
      return [{
        timestamp: finiteNumber(event.timestamp),
        type: event.type.slice(0, 64),
        detail: typeof event.detail === "string" ? event.detail.slice(0, 256) : undefined,
      }];
    })
    : [];

  return {
    timestamp: finiteNumber(source.timestamp),
    backendRunning: source.backendRunning === true,
    processMonitorMode: typeof source.processMonitorMode === "string" ? source.processMonitorMode : "unknown",
    processScanCount: finiteNumber(source.processScanCount),
    lastProcessScanAt: nullableTimestamp(source.lastProcessScanAt),
    lastProcessEventAt: nullableTimestamp(source.lastProcessEventAt),
    manualRuleCount: finiteNumber(source.manualRuleCount),
    manualActiveApp: typeof source.manualActiveApp === "string" ? source.manualActiveApp : null,
    dbusRequestCount: finiteNumber(source.dbusRequestCount),
    pushListenerActive: source.pushListenerActive === true,
    pushReconnectCount: finiteNumber(source.pushReconnectCount),
    lastFullSyncAt: nullableTimestamp(source.lastFullSyncAt),
    lastFullSyncSuccessful: typeof source.lastFullSyncSuccessful === "boolean"
      ? source.lastFullSyncSuccessful
      : null,
    powerOverrideActive: source.powerOverrideActive === true,
    powerOverrideSnapshot: parseSteamPowerSettings(source.powerOverrideSnapshot),
    systemPowerSettings: parseSteamPowerSettings(source.systemPowerSettings),
    recentEvents,
  };
};
