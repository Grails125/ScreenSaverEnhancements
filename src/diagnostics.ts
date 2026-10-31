import { parseSteamPowerSettings, PowerSettings } from "./powerSettings";
import type { NestedMprisSource } from "./deckyApi";

type NestedMprisStatus = 'stopped' | 'checking' | 'waiting' | 'waiting_event' | 'watching' | 'partial' | 'error' | 'unknown';

export type DiagnosticEvent = {
  timestamp: number;
  type: string;
  detail?: string;
  application?: string;
  reason?: string;
  cookie?: number;
  service?: string;
};

export type Diagnostics = {
  timestamp: number;
  backendRunning: boolean;
  dbusServices: { name: string; status: 'owned' | 'external'; owner: string | null; pid: number | null; process: string | null }[];
  dbusObserverStatus: string;
  dbusObservationComplete: boolean;
  observedDbusRequestCount: number;
  processMonitorMode: string;
  processScanCount: number;
  lastProcessScanAt: number | null;
  lastProcessEventAt: number | null;
  manualRuleCount: number;
  manualActiveApp: string | null;
  dbusRequestCount: number;
  nestedMprisActive: boolean;
  nestedMprisSources: NestedMprisSource[];
  nestedMprisScanCount: number;
  nestedMprisLastScanAt: number | null;
  nestedMprisBusCount: number;
  nestedMprisStatus: NestedMprisStatus;
  /** Delay after each check; null when waiting for events, stopped or unavailable. */
  nestedMprisPollIntervalSeconds: number | null;
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
        application: typeof event.application === "string" ? event.application.slice(0, 256) : undefined,
        reason: typeof event.reason === "string" ? event.reason.slice(0, 256) : undefined,
        cookie: typeof event.cookie === "number" ? event.cookie : undefined,
        service: typeof event.service === "string" ? event.service.slice(0, 256) : undefined,
      }];
    })
    : [];

  return {
    timestamp: finiteNumber(source.timestamp),
    backendRunning: source.backendRunning === true,
    dbusServices: Array.isArray(source.dbusServices) ? source.dbusServices.slice(0, 4).flatMap(item => {
      if (!item || typeof item.name !== 'string' || !['owned', 'external'].includes(item.status)) return [];
      return [{ name: item.name.slice(0, 256), status: item.status as 'owned' | 'external',
        owner: typeof item.owner === 'string' ? item.owner.slice(0, 256) : null,
        pid: typeof item.pid === 'number' && Number.isSafeInteger(item.pid) && item.pid > 0 ? item.pid : null,
        process: typeof item.process === 'string' ? item.process.slice(0, 256) : null }];
    }) : [],
    dbusObserverStatus: typeof source.dbusObserverStatus === 'string' ? source.dbusObserverStatus.slice(0, 32) : 'stopped',
    dbusObservationComplete: source.dbusObservationComplete === true,
    observedDbusRequestCount: finiteNumber(source.observedDbusRequestCount),
    processMonitorMode: typeof source.processMonitorMode === "string" ? source.processMonitorMode : "unknown",
    processScanCount: finiteNumber(source.processScanCount),
    lastProcessScanAt: nullableTimestamp(source.lastProcessScanAt),
    lastProcessEventAt: nullableTimestamp(source.lastProcessEventAt),
    manualRuleCount: finiteNumber(source.manualRuleCount),
    manualActiveApp: typeof source.manualActiveApp === "string" ? source.manualActiveApp : null,
    dbusRequestCount: finiteNumber(source.dbusRequestCount),
    nestedMprisActive: source.nestedMprisActive === true,
    nestedMprisSources: Array.isArray(source.nestedMprisSources)
      ? source.nestedMprisSources.slice(0, 100).flatMap((item): NestedMprisSource[] => {
        if (!item || typeof item !== "object" || typeof item.application !== "string"
          || typeof item.service !== "string") return [];
        return [{ application: item.application.slice(0, 256), service: item.service.slice(0, 256),
          reason: typeof item.reason === "string" ? item.reason.slice(0, 256) : "" }];
      }) : [],
    nestedMprisScanCount: finiteNumber(source.nestedMprisScanCount),
    nestedMprisLastScanAt: nullableTimestamp(source.nestedMprisLastScanAt),
    nestedMprisBusCount: finiteNumber(source.nestedMprisBusCount),
    nestedMprisStatus: typeof source.nestedMprisStatus === 'string'
      && ['stopped', 'checking', 'waiting', 'waiting_event', 'watching', 'partial', 'error'].includes(source.nestedMprisStatus)
      ? source.nestedMprisStatus as NestedMprisStatus : 'unknown',
    nestedMprisPollIntervalSeconds: typeof source.nestedMprisPollIntervalSeconds === 'number'
      && Number.isFinite(source.nestedMprisPollIntervalSeconds) && source.nestedMprisPollIntervalSeconds > 0
      ? source.nestedMprisPollIntervalSeconds : null,
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
