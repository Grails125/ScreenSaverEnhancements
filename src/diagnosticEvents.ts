export type DiagnosticEventMessage =
  | { key: "backend_started" | "backend_stopped" | "settings_changed" | "inhibit_state_changed" | "dbus_request" | "process_monitor" | "decky_music_playback" }
  | { fallback: string };

export type DiagnosticEventDetailMessage =
  | { key: "manual_apps" | "proc_connector" | "fallback_scan" | "decky_music_playing" | "decky_music_stopped" | "decky_music_audio_temporarily_missing" }
  | { fallback: string };

export type ManualAppInhibitDetail = {
  action: "inhibiting" | "released";
  application: string;
};

const EVENT_MESSAGES = {
  backend_started: "backend_started",
  backend_stopped: "backend_stopped",
  settings_changed: "settings_changed",
  inhibit_state_changed: "inhibit_state_changed",
  dbus_request: "dbus_request",
  process_monitor: "process_monitor",
  decky_music_playback: "decky_music_playback",
} as const;

const EVENT_DETAIL_MESSAGES = {
  manual_apps: "manual_apps",
  proc_connector: "proc_connector",
  fallback_scan: "fallback_scan",
  decky_music_playing: "decky_music_playing",
  decky_music_stopped: "decky_music_stopped",
  decky_music_audio_temporarily_missing: "decky_music_audio_temporarily_missing",
} as const;

export const getDiagnosticEventMessage = (value: string): DiagnosticEventMessage => {
  const key = EVENT_MESSAGES[value as keyof typeof EVENT_MESSAGES];
  return key ? { key } : { fallback: value };
};

export const getDiagnosticEventDetailMessage = (value: string): DiagnosticEventDetailMessage => {
  const key = EVENT_DETAIL_MESSAGES[value as keyof typeof EVENT_DETAIL_MESSAGES];
  return key ? { key } : { fallback: value };
};

export const getManualAppInhibitDetail = (value: string | undefined): ManualAppInhibitDetail | null => {
  const match = /^(manual_app_inhibiting|manual_app_released):(.+)$/.exec(value ?? "");
  if (!match) return null;
  return {
    action: match[1] === "manual_app_inhibiting" ? "inhibiting" : "released",
    application: match[2],
  };
};

export const shouldShowLastProcessScan = (processMonitorMode: string) => processMonitorMode === "fallback_scan";
