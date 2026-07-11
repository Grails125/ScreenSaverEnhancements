import { definePlugin, useQuickAccessVisible } from "@decky/api";
import {
  ToggleField,
  SliderField,
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  Navigation,
  staticClasses,
  Focusable,
} from "@decky/ui";
import React, { FC } from "react";
import { useState, useEffect, useRef } from 'react'
import { GiNightSleep } from "react-icons/gi";
import { RiArrowDownSFill, RiArrowUpSFill, RiInformationLine } from "react-icons/ri";
import i18n from './i18n'
import {
  BlackOverlay,
  BLACK_BACKGROUND_CLOSE_ON_ANY_KEY,
  BLACK_BACKGROUND_ENABLED,
  BLACK_BACKGROUND_OPACITY,
} from './blackOverlay'
import { QUICK_ACCESS_MENU } from './ButtonIcons'
import { copyTextToClipboard } from './clipboard'
import { Diagnostics, parseDiagnostics } from './diagnostics'
import { InhibitStatus, PluginServerApi, RunningProcess, serverApi } from './deckyApi'
import { createPushListenerHealth } from './pushListenerHealth'
import { StateNumber } from './state'
import {
  DEFAULT_POWER_SETTINGS,
  getPowerSyncAction,
  minutesToSeconds,
  normalizePowerSettings,
  parseSteamPowerSettings,
  parsePowerOverrideState,
  PowerSettings,
  PowerOverrideState,
  shouldStartInhibit,
  secondsToMinutes,
  shouldApplyPowerSettingsImmediately,
  shouldSyncSystemPowerSettings,
} from './powerSettings'

import {
  areStringArraysEqual,
  clampOpacity,
  getPluginBooleanSetting,
  getPluginNumberSetting,
  getPluginSetting,
  isPluginSettingSaveSuccessful,
  normalizeManualApps,
  setPluginSetting,
  setPluginSettings,
} from './settingsClient'

let showNotify     = false;
let language = i18n.getCurrentLanguage()
const t = i18n.useTranslations(language)
const POWER_SETTING_KEYS = {
  batteryDim: "battery_dim_timeout",
  acDim: "ac_dim_timeout",
  batterySuspend: "battery_suspend_timeout",
  acSuspend: "ac_suspend_timeout",
} as const
const POWER_CONFIG_COLLAPSED_KEY = "screensaver-enhancements-power-config-collapsed"
const UPDATE_RESTART_TARGET_KEY = "screensaver-enhancements-update-restart-target"
const UPDATE_RESTART_MAX_AGE_MS = 30 * 60 * 1000

const renderBlackBackgroundTip = () => React.createElement(
  'span',
  null,
  t('black_bg_tip_prefix'),
  ' ',
  React.createElement(QUICK_ACCESS_MENU, { style: { height: "18px", width: "auto", marginBottom: "-5px" } }),
  ' ',
  t('black_bg_tip_suffix')
)

const toScopedSelector = (className: string) => className
  .split(' ')
  .filter(Boolean)
  .map(name => `.${name}`)
  .join('')

const PANEL_LAYOUT_CSS = `
  .sse-panel-root ${toScopedSelector(staticClasses.PanelSection)} {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  .sse-panel-root ${toScopedSelector(staticClasses.PanelSectionRow)} {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
`

const PanelLayout: FC<{ children: React.ReactNode }> = ({ children }) => React.createElement(
  'div',
  { className: 'sse-panel-root' },
  React.createElement('style', null, PANEL_LAYOUT_CSS),
  children
)

const PANEL_STYLES = {
  panelAction: {
    width: '30px',
    height: '30px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '4px',
    color: 'rgba(255,255,255,0.88)',
    fontSize: '0.85em',
    flexShrink: 0,
  },
  updateSummary: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '7px',
    width: '100%',
    padding: '9px 10px',
    background: 'rgba(255,255,255,0.035)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '6px',
    boxSizing: 'border-box' as const,
  },
  updateVersionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  updateVersionLabel: {
    color: '#8d8d8d',
    fontSize: '0.76em',
  },
  updateVersionValue: {
    color: '#f1f1f1',
    fontSize: '0.82em',
    fontWeight: 'bold' as const,
    overflowWrap: 'anywhere' as const,
    textAlign: 'right' as const,
  },
  releaseNotes: {
    width: '100%',
    maxHeight: '180px',
    overflowY: 'auto' as const,
    padding: '9px 10px',
    background: 'rgba(93,185,255,0.06)',
    border: '1px solid rgba(93,185,255,0.2)',
    borderRadius: '6px',
    boxSizing: 'border-box' as const,
    color: '#d7e8f7',
    fontSize: '0.78em',
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap' as const,
    overflowWrap: 'anywhere' as const,
  },
  badge: (type: string) => ({
    fontSize: '0.65em',
    padding: '3px 6px',
    borderRadius: '999px',
    background: type === 'app' ? 'rgba(125, 214, 160, 0.12)' : 'rgba(255,255,255,0.07)',
    color: type === 'app' ? '#8ee0aa' : '#b8b8b8',
    border: `1px solid ${type === 'app' ? 'rgba(125, 214, 160, 0.28)' : 'rgba(255,255,255,0.1)'}`,
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
  }),
  processItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '10px',
    flex: 1,
    padding: '9px 10px',
    background: 'rgba(255,255,255,0.035)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '6px',
    boxSizing: 'border-box' as const,
    overflow: 'hidden' as const
  },
  emptyState: {
    textAlign: 'center' as const,
    color: '#8d8d8d',
    padding: '12px',
    fontSize: '0.82em',
    lineHeight: 1.45,
  },
  sectionHint: {
    fontSize: '0.78em',
    color: '#8d8d8d',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    width: '100%',
    padding: '6px 2px',
    boxSizing: 'border-box' as const,
  },
  menuMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
  },
  menuIcon: {
    width: '30px',
    height: '30px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.86)',
    fontSize: '1em',
    flexShrink: 0,
  },
  menuText: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '3px',
    minWidth: 0,
  },
  menuTitle: {
    color: '#f1f1f1',
    fontSize: '0.94em',
    fontWeight: 600,
  },
  menuDescription: {
    color: '#8d8d8d',
    fontSize: '0.75em',
    lineHeight: 1.35,
  },
  pageHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    width: '100%',
    padding: '8px 2px',
    boxSizing: 'border-box' as const,
  },
  pageHeaderMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
    flex: 1,
  },
  backIcon: {
    width: '30px',
    height: '30px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.18)',
    color: '#fff',
    fontSize: '1.35em',
    fontWeight: 700,
    lineHeight: 1,
    flexShrink: 0,
  },
  backButton: {
    width: '34px',
    height: '34px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.12)',
    border: '1px solid rgba(255,255,255,0.22)',
    color: '#fff',
    fontSize: '1.45em',
    fontWeight: 700,
    lineHeight: 1,
    flexShrink: 0,
  },
  chevron: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: '1.1em',
    flexShrink: 0,
  },
  menuTrailing: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
  },
  countBadge: {
    minWidth: '22px',
    height: '22px',
    padding: '0 7px',
    borderRadius: '999px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(125, 214, 160, 0.14)',
    border: '1px solid rgba(125, 214, 160, 0.28)',
    color: '#8ee0aa',
    fontSize: '0.72em',
    fontWeight: 700,
    boxSizing: 'border-box' as const,
  },
  processName: {
    color: '#f1f1f1',
    fontSize: '0.9em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  }
}

const APP_NAMES: Record<string, string> = {
  "vlc": "VLC 播放器",
  "mpv": "MPV 播放器",
  "chrome": "谷歌浏览器",
  "firefox-bin": "火狐浏览器",
  "wiliwili": "Wiliwili (B站)",
  "steam": "Steam 客户端",
  "gamescope": "游戏窗口管理器",
  "discord": "Discord",
  "obs": "OBS 录屏软件",
  "retroarch": "RetroArch 模拟器",
  "dolphin-emu": "Dolphin 模拟器",
  "pcsx2": "PCSX2 模拟器",
  "kodi": "Kodi 媒体中心",
  "bash": "终端 (Bash)",
  "python": "Python 脚本",
  "node": "Node.js 应用",
  "flatpak": "Flatpak 管理器",
};

const getAppDisplayName = (application?: string) => {
  const normalized = application?.trim() || "";
  const shortName = normalized.split('.').pop() || normalized;
  return APP_NAMES[normalized] || APP_NAMES[shortName] || normalized;
}
const RUN_ON_LOGIN = "run_on_login"
const SHOW_NOTIFY  = "show_notify"
const DECKY_MUSIC_APP = "DeckyMusic"

const EMPTY_INHIBIT_STATUS: InhibitStatus = {
  manual_apps: [],
  manual_active_app: null,
  manual_active: false,
  dbus_requests: [],
  dbus_active: false,
  is_inhibiting: false,
};

type InhibitAppsPageProps = {
  manualApps: string[];
  inhibitStatus: InhibitStatus;
  deckyMusicActive: boolean;
  runningProcesses: RunningProcess[];
  refreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onAddApp: (appName: string) => void;
  onRemoveApp: (appName: string) => void;
};

const InhibitAppsPage: FC<InhibitAppsPageProps> = ({
  manualApps,
  inhibitStatus,
  deckyMusicActive,
  runningProcesses,
  refreshing,
  onBack,
  onRefresh,
  onAddApp,
  onRemoveApp,
}) => (
  <PanelLayout>
    <PanelSection>
      <PanelSectionRow>
        <div style={PANEL_STYLES.pageHeader}>
          <div style={PANEL_STYLES.pageHeaderMain}>
            <Focusable
              style={PANEL_STYLES.backButton}
              onClick={onBack}
            >
              ‹
            </Focusable>
            <div style={PANEL_STYLES.menuText}>
              <span style={PANEL_STYLES.menuTitle}>{t('Inhibit Apps')}</span>
              <span style={PANEL_STYLES.menuDescription}>{t('app_rules_tip')}</span>
            </div>
          </div>
          {manualApps.length > 0 && (
            <span style={PANEL_STYLES.countBadge}>{manualApps.length}</span>
          )}
        </div>
      </PanelSectionRow>
    </PanelSection>

    <PanelSection title={t('Inhibit List')}>
      {manualApps.length === 0 && (
        <PanelSectionRow>
          <div style={PANEL_STYLES.emptyState}>
            {t('manual_tip')}
          </div>
        </PanelSectionRow>
      )}
      {manualApps.map((app) => (
        <PanelSectionRow key={app}>
          <div style={PANEL_STYLES.processItem}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <span style={{color: '#5db9ff', fontWeight: 'bold'}}>●</span>
              <span style={PANEL_STYLES.processName}>{APP_NAMES[app] || app}</span>
            </div>
            <Focusable
              style={PANEL_STYLES.panelAction}
              onClick={() => onRemoveApp(app)}
            >
              ✕
            </Focusable>
          </div>
        </PanelSectionRow>
      ))}
    </PanelSection>

    <PanelSection title={t('Active Inhibit Sources')}>
      {!inhibitStatus.manual_active && !deckyMusicActive && inhibitStatus.dbus_requests.length === 0 && (
        <PanelSectionRow>
          <div style={PANEL_STYLES.emptyState}>
            {t('No Active Inhibit')}
          </div>
        </PanelSectionRow>
      )}
      {inhibitStatus.manual_active && inhibitStatus.manual_active_app && (
        <PanelSectionRow>
          <div style={PANEL_STYLES.processItem}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <span style={PANEL_STYLES.processName}>{APP_NAMES[inhibitStatus.manual_active_app] || inhibitStatus.manual_active_app}</span>
              <span style={PANEL_STYLES.sectionHint}>{t('Manual Inhibit Source')}</span>
            </div>
            <span style={PANEL_STYLES.badge('app')}>{t('Active')}</span>
          </div>
        </PanelSectionRow>
      )}
      {deckyMusicActive && (
        <PanelSectionRow>
          <div style={PANEL_STYLES.processItem}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <span style={PANEL_STYLES.processName}>{DECKY_MUSIC_APP}</span>
              <span style={PANEL_STYLES.sectionHint}>{t('DeckyMusic Inhibit Source')}</span>
            </div>
            <span style={PANEL_STYLES.badge('app')}>{t('Active')}</span>
          </div>
        </PanelSectionRow>
      )}
      {inhibitStatus.dbus_requests.map((request) => (
        <PanelSectionRow key={request.cookie}>
          <div style={PANEL_STYLES.processItem}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <span style={PANEL_STYLES.processName}>{APP_NAMES[request.application] || request.application}</span>
              <span style={PANEL_STYLES.sectionHint}>{request.reason || t('DBus Inhibit Source')}</span>
            </div>
            <span style={PANEL_STYLES.badge('system')}>{t('Active')}</span>
          </div>
        </PanelSectionRow>
      ))}
    </PanelSection>

    <PanelSection title={t('Running Processes')}>
      <PanelSectionRow>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0 2px', boxSizing: 'border-box' }}>
          <span style={PANEL_STYLES.sectionHint}>{t('Click to add')}</span>
          <Focusable
            style={PANEL_STYLES.panelAction}
            onClick={onRefresh}
          >
            {refreshing ? "..." : "↻"}
          </Focusable>
        </div>
      </PanelSectionRow>
      <Focusable style={{maxHeight: '400px', overflowY: 'scroll', padding: '2px'}}>
        {runningProcesses
          .filter(p => !manualApps.includes(p.name))
          .map(proc => (
            <PanelSectionRow key={proc.name}>
              <div style={PANEL_STYLES.processItem}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={PANEL_STYLES.processName}>{APP_NAMES[proc.name] || proc.name}</span>
                    <span style={PANEL_STYLES.badge(proc.type)}>
                      {proc.type === 'app' ? "应用" : "系统"}
                    </span>
                  </div>
                  {APP_NAMES[proc.name] && (
                    <span style={{fontSize: '0.7em', color: '#777'}}>{proc.name}</span>
                  )}
                </div>
                <Focusable
                  style={PANEL_STYLES.panelAction}
                  onClick={() => onAddApp(proc.name)}
                >
                  ＋
                </Focusable>
              </div>
            </PanelSectionRow>
          ))
        }
      </Focusable>
    </PanelSection>
  </PanelLayout>
);

const formatDiagnosticTime = (timestamp: number | null) => timestamp
  ? new Date(timestamp * 1000).toLocaleString()
  : t('Not Available');

const formatProcessMonitorMode = (mode: string) => {
  switch (mode) {
    case 'proc_connector': return t('proc_connector');
    case 'fallback_scan': return t('fallback_scan');
    case 'stopped': return t('stopped');
    case 'not_started': return t('not_started');
    default: return t('unknown');
  }
};

const formatDiagnosticEventType = (type: string) => {
  switch (type) {
    case 'backend_started': return t('backend_started');
    case 'backend_stopped': return t('backend_stopped');
    default: return type;
  }
};

const DiagnosticRow: FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <PanelSectionRow>
    <div style={PANEL_STYLES.processItem}>
      <span style={PANEL_STYLES.sectionHint}>{label}</span>
      <span style={{ color: '#f1f1f1', fontSize: '0.82em', textAlign: 'right' }}>{value}</span>
    </div>
  </PanelSectionRow>
);

const MonitorStatusRow: FC<{ running: boolean; processMonitorMode: string }> = ({
  running,
  processMonitorMode,
}) => {
  const [detailsVisible, setDetailsVisible] = useState(false);

  return (
    <PanelSectionRow>
      <div style={{ ...PANEL_STYLES.processItem, overflow: 'visible', position: 'relative' }}>
        <span style={PANEL_STYLES.sectionHint}>{t('Backend Status')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#f1f1f1', fontSize: '0.82em', textAlign: 'right' }}>
            {running ? t('Running') : t('Stopped')}
          </span>
          <Focusable
            aria-label={t('Monitor Details')}
            aria-expanded={detailsVisible}
            aria-controls="sse-monitor-details"
            style={{ ...PANEL_STYLES.panelAction, width: '28px', height: '28px' }}
            onClick={() => setDetailsVisible(!detailsVisible)}
          >
            <RiInformationLine aria-hidden="true" />
          </Focusable>
        </div>
        {detailsVisible && (
          <div
            id="sse-monitor-details"
            role="tooltip"
            style={{
              position: 'absolute',
              zIndex: 20,
              top: 'calc(100% + 6px)',
              right: 0,
              width: '260px',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.18)',
              background: '#20242b',
              color: '#f1f1f1',
              boxShadow: '0 8px 24px rgba(0,0,0,0.38)',
              fontSize: '0.76em',
              lineHeight: 1.45,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' }}>
              <span style={{ color: '#aeb5bf' }}>{t('Monitoring Method')}</span>
              <span style={{ textAlign: 'right' }}>{formatProcessMonitorMode(processMonitorMode)}</span>
            </div>
            <div style={{ color: '#c7cbd1' }}>{t('monitor_details_tip')}</div>
          </div>
        )}
      </div>
    </PanelSectionRow>
  );
};

type DiagnosticsPageProps = {
  diagnostics: Diagnostics | null;
  loading: boolean;
  exportStatus: string;
  onBack: () => void;
  onRefresh: () => void;
  onExport: () => void;
};

type EventChannelDiagnostics = Pick<
  Diagnostics,
  'pushListenerActive' | 'pushReconnectCount' | 'lastFullSyncAt' | 'lastFullSyncSuccessful'
>;

const DiagnosticsPage: FC<DiagnosticsPageProps> = ({
  diagnostics,
  loading,
  exportStatus,
  onBack,
  onRefresh,
  onExport,
}) => (
  <PanelLayout>
    <PanelSection>
      <PanelSectionRow>
        <div style={PANEL_STYLES.pageHeader}>
          <div style={PANEL_STYLES.pageHeaderMain}>
            <Focusable style={PANEL_STYLES.backButton} onClick={onBack}>
              ←
            </Focusable>
            <div style={PANEL_STYLES.menuText}>
              <span style={PANEL_STYLES.menuTitle}>{t('Diagnostics')}</span>
              <span style={PANEL_STYLES.menuDescription}>{t('diagnostics_tip')}</span>
            </div>
          </div>
          <Focusable style={PANEL_STYLES.panelAction} onClick={onRefresh}>
            {loading ? '...' : '↻'}
          </Focusable>
        </div>
      </PanelSectionRow>
    </PanelSection>

    {!diagnostics ? (
      <PanelSection>
        <PanelSectionRow>
          <div style={PANEL_STYLES.emptyState}>{loading ? t('Loading') : t('Diagnostics Unavailable')}</div>
        </PanelSectionRow>
      </PanelSection>
    ) : (
      <>
        <PanelSection title={t('Runtime Status')}>
          <MonitorStatusRow
            running={diagnostics.backendRunning}
            processMonitorMode={diagnostics.processMonitorMode}
          />
          <DiagnosticRow label={t('Process Scan Count')} value={diagnostics.processScanCount} />
          <DiagnosticRow label={t('Last Process Scan')} value={formatDiagnosticTime(diagnostics.lastProcessScanAt)} />
          <DiagnosticRow label={t('Last Process Event')} value={formatDiagnosticTime(diagnostics.lastProcessEventAt)} />
          <DiagnosticRow label={t('Manual Rule Count')} value={diagnostics.manualRuleCount} />
          <DiagnosticRow label={t('Active Application')} value={diagnostics.manualActiveApp || t('None')} />
          <DiagnosticRow label={t('D-Bus Request Count')} value={diagnostics.dbusRequestCount} />
          <DiagnosticRow label={t('Power Recovery Active')} value={diagnostics.powerOverrideActive ? t('Yes') : t('No')} />
        </PanelSection>

        {diagnostics.systemPowerSettings && (
          <PanelSection title={t('System Power Settings')}>
            <DiagnosticRow label={t('Battery Dim Timeout')} value={`${diagnostics.systemPowerSettings.batteryDim}${t('Seconds')}`} />
            <DiagnosticRow label={t('AC Dim Timeout')} value={`${diagnostics.systemPowerSettings.acDim}${t('Seconds')}`} />
            <DiagnosticRow label={t('Battery Suspend Timeout')} value={`${diagnostics.systemPowerSettings.batterySuspend}${t('Seconds')}`} />
            <DiagnosticRow label={t('AC Suspend Timeout')} value={`${diagnostics.systemPowerSettings.acSuspend}${t('Seconds')}`} />
          </PanelSection>
        )}

        <PanelSection title={t('Event Channel')}>
          <DiagnosticRow
            label={t('Push Listener')}
            value={diagnostics.pushListenerActive ? t('Connected') : t('Disconnected')}
          />
          <DiagnosticRow label={t('Reconnect Count')} value={diagnostics.pushReconnectCount} />
          <DiagnosticRow
            label={t('Last Full Sync')}
            value={diagnostics.lastFullSyncAt === null
              ? t('Not Available')
              : `${formatDiagnosticTime(diagnostics.lastFullSyncAt)} (${diagnostics.lastFullSyncSuccessful ? t('Successful') : t('Failed')})`}
          />
        </PanelSection>

        <PanelSection title={t('Recent Plugin Events')}>
          {diagnostics.recentEvents.length === 0 ? (
            <PanelSectionRow><div style={PANEL_STYLES.emptyState}>{t('No Recent Events')}</div></PanelSectionRow>
          ) : diagnostics.recentEvents.slice().reverse().map((event, index) => (
            <PanelSectionRow key={`${event.timestamp}-${event.type}-${index}`}>
              <div style={PANEL_STYLES.processItem}>
                <div style={PANEL_STYLES.menuText}>
                  <span style={PANEL_STYLES.processName}>{formatDiagnosticEventType(event.type)}</span>
                  <span style={PANEL_STYLES.sectionHint}>{event.detail || formatDiagnosticTime(event.timestamp)}</span>
                </div>
                <span style={PANEL_STYLES.sectionHint}>{new Date(event.timestamp * 1000).toLocaleTimeString()}</span>
              </div>
            </PanelSectionRow>
          ))}
        </PanelSection>

        <PanelSection>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={onExport}>{exportStatus || t('Copy Diagnostic Report')}</ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      </>
    )}
  </PanelLayout>
);

const Content: FC<{
  serverApi: PluginServerApi;
  backendState: StateNumber;
  overlayState: StateNumber;
  opacityState: StateNumber;
  deckyMusicState: StateNumber;
  onPowerSettingsLoaded: (settings: PowerSettings) => void;
  onPowerSettingsApply: (settings: PowerSettings) => Promise<void>;
  readSystemPowerSettings: () => Promise<PowerSettings | null>;
  onMonitorChanged: () => Promise<void>;
  getEventChannelDiagnostics: () => EventChannelDiagnostics;
}> = ({serverApi, backendState, overlayState, opacityState, deckyMusicState, onPowerSettingsLoaded, onPowerSettingsApply, readSystemPowerSettings, onMonitorChanged, getEventChannelDiagnostics}) => {
  const [running, setRunning] = useState<boolean>(backendState.GetState() === 1);
  const [notify, setNotify] = useState<boolean>(showNotify);
  const [blackBackground, setBlackBackground] = useState<boolean>(overlayState.GetState() === 1);
  const [blackBackgroundOpacity, setBlackBackgroundOpacity] = useState<number>(opacityState.GetState());
  const [closeOnAnyKey, setCloseOnAnyKey] = useState<boolean>(false);
  const [closeOnAnyKeyLoaded, setCloseOnAnyKeyLoaded] = useState<boolean>(false);
  const [pluginVersion, setPluginVersion] = useState<string>('');
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [updateNotes, setUpdateNotes] = useState<string>('');
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
  const [checkingUpdate, setCheckingUpdate] = useState<boolean>(false);
  const [installingUpdate, setInstallingUpdate] = useState<boolean>(false);
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState<string>('');
  const [updateSha256, setUpdateSha256] = useState<string>('');
  const [powerSettings, setPowerSettings] = useState<PowerSettings>(DEFAULT_POWER_SETTINGS);
  const [deckyMusicActive, setDeckyMusicActive] = useState<boolean>(deckyMusicState.GetState() === 1);
  const [powerConfigCollapsed, setPowerConfigCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(POWER_CONFIG_COLLAPSED_KEY);
      return saved !== null ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  const startBackend = async () => {
    return await serverApi.startBackend();
  }

  const stopBackend = async () => {
    return await serverApi.stopBackend();
  }

  const isBackendRunning = async () => {
    return await serverApi.isRunning();
  }

  const saveSetting = async (
    key: string,
    value: any,
    rollback: () => void,
  ): Promise<boolean> => {
    try {
      const response = await setPluginSetting(serverApi, key, value);
      if (isPluginSettingSaveSuccessful(response)) return true;
      throw new Error("settings RPC failed");
    } catch {
      rollback();
      serverApi.toaster.toast({
        title: t("Settings Save Failed"),
        body: t("Settings Save Failed Body"),
        icon: <GiNightSleep />,
        critical: true,
        duration: 4000,
      });
      return false;
    }
  }

  const [manualApps, setManualApps] = useState<string[]>([]);
  const [inhibitStatus, setInhibitStatus] = useState<InhibitStatus>(EMPTY_INHIBIT_STATUS);
  const [runningProcesses, setRunningProcesses] = useState<RunningProcess[]>([]);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [showAppMenu, setShowAppMenu] = useState<boolean>(false);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState<boolean>(false);
  const [diagnosticsExportStatus, setDiagnosticsExportStatus] = useState<string>('');
  const quickAccessVisible = useQuickAccessVisible();
  const quickAccessWasVisible = useRef(quickAccessVisible);
  const panelVisible = useRef(true);
  const requestTokenRef = useRef(0);
  const opacitySaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOpacityRef = useRef<number | null>(null);
  const persistedOpacityRef = useRef(opacityState.GetState());
  const updateCheckInFlight = useRef(false);

  const isCurrentRequest = (token: number) => {
    return panelVisible.current && requestTokenRef.current === token;
  }

  const applySystemPowerSettings = async () => {
    try {
      const systemSettings = await readSystemPowerSettings();
      if (!systemSettings) return;

      setPowerSettings(systemSettings);
      onPowerSettingsLoaded(systemSettings);
      const response = await setPluginSettings(serverApi, Object.fromEntries(
        (Object.keys(POWER_SETTING_KEYS) as Array<keyof PowerSettings>).map(
          key => [POWER_SETTING_KEYS[key], systemSettings[key]],
        ),
      ));
      if (!isPluginSettingSaveSuccessful(response)) {
        console.warn("[ScreenSaverEnhancements] Could not persist synchronized power settings");
      }
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not synchronize system power settings", error);
    }
  }

  const notifyMonitorStatus = (enabled: boolean) => {
    if (!notify) return;
    serverApi.toaster.toast({
      title: t("Background Monitor"),
      body: enabled ? t("Monitor Enabled Body") : t("Monitor Disabled Body"),
      icon: <GiNightSleep />,
      sound: 1,
      duration: 3000,
    });
  };

  const persistPendingOpacity = async () => {
    const opacity = pendingOpacityRef.current;
    pendingOpacityRef.current = null;
    opacitySaveTimeoutRef.current = null;
    if (opacity === null) return;

    try {
      const response = await setPluginSetting(serverApi, BLACK_BACKGROUND_OPACITY, opacity);
      if (isPluginSettingSaveSuccessful(response)) {
        persistedOpacityRef.current = opacity;
        return;
      }
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not save black background opacity", error);
    }

    if (pendingOpacityRef.current !== null) return;
    const previous = persistedOpacityRef.current;
    setBlackBackgroundOpacity(previous);
    opacityState.SetState(previous);
    serverApi.toaster.toast({
      title: t("Settings Save Failed"),
      body: t("Settings Save Failed Body"),
      icon: <GiNightSleep />,
      critical: true,
      duration: 4000,
    });
  }

  const scheduleOpacitySave = (opacity: number) => {
    pendingOpacityRef.current = opacity;
    if (opacitySaveTimeoutRef.current !== null) {
      clearTimeout(opacitySaveTimeoutRef.current);
    }
    opacitySaveTimeoutRef.current = setTimeout(() => {
      void persistPendingOpacity();
    }, 300);
  }

  const fetchRunningProcesses = async () => {
    if (!panelVisible.current) return;
    const token = requestTokenRef.current;
    setRefreshing(true);
    try {
      const processes = await serverApi.getRunningProcesses();
      if (isCurrentRequest(token)) {
        setRunningProcesses(processes);
      }
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not load running processes", error);
    } finally {
      if (isCurrentRequest(token)) {
        setRefreshing(false);
      }
    }
  }

  const fetchInhibitStatus = async () => {
    if (!panelVisible.current) return;
    const token = requestTokenRef.current;
    try {
      const result = await serverApi.getInhibitStatus();
      if (isCurrentRequest(token) && result) {
        setInhibitStatus({
          ...EMPTY_INHIBIT_STATUS,
          ...result,
          manual_apps: normalizeManualApps(result.manual_apps),
          dbus_requests: Array.isArray(result.dbus_requests) ? result.dbus_requests : [],
        });
      }
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not load inhibit status", error);
    }
  }

  const refreshInhibitStatus = async () => {
    await fetchInhibitStatus();
  }

  const checkUpdate = async () => {
    if (updateCheckInFlight.current) return;
    updateCheckInFlight.current = true;
    setCheckingUpdate(true);
    const token = requestTokenRef.current;
    try {
      const result = await serverApi.checkUpdate();
      if (!isCurrentRequest(token)) return;
      if (result.error) throw new Error(result.error);

      setPluginVersion(result.current);
      setLatestVersion(result.latest);
      setUpdateAvailable(result.has_update);
      setUpdateNotes(result.has_update ? result.notes : '');
      setUpdateDownloadUrl(result.has_update ? result.download_url : '');
      setUpdateSha256(result.has_update ? result.sha256 : '');
      serverApi.toaster.toast({
        title: t(result.has_update ? 'Update Available' : 'No Update'),
        body: result.has_update
          ? `${result.current} → ${result.latest}`
          : t('Already Latest Version'),
        icon: <GiNightSleep />,
        critical: result.has_update,
        duration: result.has_update ? 5000 : 3000,
      });
    } catch (error) {
      console.warn('[ScreenSaverEnhancements] Update check failed', error);
      if (isCurrentRequest(token)) {
        setUpdateAvailable(false);
        setUpdateNotes('');
        setUpdateDownloadUrl('');
        setUpdateSha256('');
        serverApi.toaster.toast({
          title: t('Update Check Failed'),
          body: t('Update Check Failed'),
          icon: <GiNightSleep />,
          critical: true,
          duration: 4000,
        });
      }
    } finally {
      updateCheckInFlight.current = false;
      if (isCurrentRequest(token)) setCheckingUpdate(false);
    }
  }

  const installUpdate = async () => {
    if (installingUpdate || !updateAvailable || !updateDownloadUrl || !updateSha256) return;
    setInstallingUpdate(true);
    try {
      localStorage.setItem(UPDATE_RESTART_TARGET_KEY, JSON.stringify({
        version: latestVersion,
        requestedAt: Date.now(),
      }));
      await serverApi.installPluginUpdate({
        downloadUrl: updateDownloadUrl,
        version: latestVersion,
        sha256: updateSha256,
      });
    } catch (error) {
      localStorage.removeItem(UPDATE_RESTART_TARGET_KEY);
      console.error('[ScreenSaverEnhancements] Update installation failed', error);
      serverApi.toaster.toast({
        title: t('Update Install Failed'),
        body: t('Update Install Failed'),
        icon: <GiNightSleep />,
        critical: true,
        duration: 4000,
      });
    } finally {
      setInstallingUpdate(false);
    }
  }

  const refreshAppMenuData = async () => {
    await Promise.all([
      fetchRunningProcesses(),
      fetchInhibitStatus(),
    ]);
  }

  const refreshDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      const result = await serverApi.getDiagnostics();
      const parsed = parseDiagnostics(result);
      setDiagnostics(parsed ? { ...parsed, ...getEventChannelDiagnostics() } : null);
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not load diagnostics", error);
      setDiagnostics(null);
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  const exportDiagnostics = async () => {
    if (!diagnostics) return;
    const copied = await copyTextToClipboard(JSON.stringify(diagnostics, null, 2));
    if (copied) {
      setDiagnosticsExportStatus(t('Diagnostic Report Copied'));
    } else {
      console.warn("[ScreenSaverEnhancements] No clipboard method succeeded");
      setDiagnosticsExportStatus(t('Diagnostic Export Failed'));
    }
    setTimeout(() => setDiagnosticsExportStatus(''), 2000);
  }

  const updatePowerSetting = async (
    field: keyof PowerSettings,
    value: unknown,
  ) => {
    const previous = powerSettings;
    const next = normalizePowerSettings({ ...powerSettings, [field]: value });
    setPowerSettings(next);
    const saved = await saveSetting(POWER_SETTING_KEYS[field], next[field], () => {
      setPowerSettings(previous);
    });
    if (!saved) return;

    try {
      await onPowerSettingsApply(next);
    } catch (error) {
      console.error("[ScreenSaverEnhancements] Could not apply power settings", error);
      setPowerSettings(previous);
      void setPluginSetting(serverApi, POWER_SETTING_KEYS[field], previous[field]);
      serverApi.toaster.toast({
        title: t("Power Settings Apply Failed"),
        body: t("Power Settings Apply Failed Body"),
        icon: <GiNightSleep />,
        critical: true,
        duration: 4000,
      });
    }
  }

  useEffect(() => {
    panelVisible.current = true;
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    const fetchManualApps = async () => {
      const storedApps = await getPluginSetting(serverApi, "manual_apps", []);
      if (!isCurrentRequest(token)) return;

      const normalizedApps = normalizeManualApps(storedApps);
      setManualApps(normalizedApps);
      if (Array.isArray(storedApps) && !areStringArraysEqual(normalizedApps, storedApps)) {
        await setPluginSetting(serverApi, "manual_apps", normalizedApps);
      }
    };
    fetchManualApps();
    refreshInhibitStatus();

    const loadBackendState = async () => {
      try {
        const isRunning = await isBackendRunning();
        if (!isCurrentRequest(token)) return;
        backendState.SetState(isRunning ? 1 : 0);
        setRunning(isRunning);
      } catch (error) {
        console.warn("[ScreenSaverEnhancements] Could not read backend state", error);
      }
    };
    loadBackendState();

    const loadBlackBackgroundSettings = async () => {
      const [enabled, opacityValue, closeOnAnyKey] = await Promise.all([
        getPluginBooleanSetting(serverApi, BLACK_BACKGROUND_ENABLED, false),
        getPluginNumberSetting(serverApi, BLACK_BACKGROUND_OPACITY, 1),
        getPluginBooleanSetting(serverApi, BLACK_BACKGROUND_CLOSE_ON_ANY_KEY, false),
      ]);
      if (!isCurrentRequest(token)) return;

      const opacity = clampOpacity(opacityValue);
      persistedOpacityRef.current = opacity;
      setBlackBackground(enabled);
      overlayState.SetState(enabled ? 1 : 0);
      setBlackBackgroundOpacity(opacity);
      opacityState.SetState(opacity);
      setCloseOnAnyKey(closeOnAnyKey);
      setCloseOnAnyKeyLoaded(true);
    };
    loadBlackBackgroundSettings();

    const loadPluginVersion = async () => {
      try {
        const version = await serverApi.getPluginVersion();
        if (isCurrentRequest(token)) setPluginVersion(version);
        const pendingRestart = localStorage.getItem(UPDATE_RESTART_TARGET_KEY);
        if (pendingRestart) {
          const { version: restartTarget, requestedAt } = JSON.parse(pendingRestart) as {
            version?: unknown;
            requestedAt?: unknown;
          };
          if (version === restartTarget) {
            localStorage.removeItem(UPDATE_RESTART_TARGET_KEY);
            void serverApi.restartDecky().catch(() => undefined);
          } else if (typeof requestedAt !== 'number' || Date.now() - requestedAt > UPDATE_RESTART_MAX_AGE_MS) {
            localStorage.removeItem(UPDATE_RESTART_TARGET_KEY);
          }
        }
      } catch (error) {
        console.warn('[ScreenSaverEnhancements] Could not load plugin version', error);
      }
    };
    void loadPluginVersion();

    const loadPowerSettings = async () => {
      const [batteryDim, acDim, batterySuspend, acSuspend] = await Promise.all([
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.batteryDim, DEFAULT_POWER_SETTINGS.batteryDim),
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.acDim, DEFAULT_POWER_SETTINGS.acDim),
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.batterySuspend, DEFAULT_POWER_SETTINGS.batterySuspend),
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.acSuspend, DEFAULT_POWER_SETTINGS.acSuspend),
      ]);
      if (!isCurrentRequest(token)) return;
      const next = normalizePowerSettings({ batteryDim, acDim, batterySuspend, acSuspend });
      setPowerSettings(next);
      onPowerSettingsLoaded(next);
      await applySystemPowerSettings();
    };
    loadPowerSettings();

    const onOverlayChanged = (mode: number) => {
      setBlackBackground(mode === 1);
    };
    const onBackendChanged = (mode: number) => {
      setRunning(mode === 1);
    };
    const onOpacityChanged = (value: number) => {
      setBlackBackgroundOpacity(Math.min(1, Math.max(0, value)));
    };
    backendState.onStateChanged(onBackendChanged);
    overlayState.onStateChanged(onOverlayChanged);
    opacityState.onStateChanged(onOpacityChanged);
    const onDeckyMusicChanged = (value: number) => setDeckyMusicActive(value === 1);
    deckyMusicState.onStateChanged(onDeckyMusicChanged);

    return () => {
      panelVisible.current = false;
      requestTokenRef.current += 1;
      if (opacitySaveTimeoutRef.current !== null) {
        clearTimeout(opacitySaveTimeoutRef.current);
      }
      if (pendingOpacityRef.current !== null) {
        void setPluginSetting(serverApi, BLACK_BACKGROUND_OPACITY, pendingOpacityRef.current);
        pendingOpacityRef.current = null;
      }
      backendState.offStateChanged(onBackendChanged);
      overlayState.offStateChanged(onOverlayChanged);
      opacityState.offStateChanged(onOpacityChanged);
      deckyMusicState.offStateChanged(onDeckyMusicChanged);
    };
  }, [backendState, overlayState, opacityState, deckyMusicState]);

  useEffect(() => {
    if (!quickAccessVisible) return;
    void refreshInhibitStatus();
  }, [quickAccessVisible]);

  useEffect(() => {
    const becameVisible = quickAccessVisible && !quickAccessWasVisible.current;
    quickAccessWasVisible.current = quickAccessVisible;
    if (becameVisible) {
      void applySystemPowerSettings();
    }
  }, [quickAccessVisible]);

  useEffect(() => {
    try {
      localStorage.setItem(POWER_CONFIG_COLLAPSED_KEY, JSON.stringify(powerConfigCollapsed));
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not save power configuration display state", error);
    }
  }, [powerConfigCollapsed]);

  const addApp = async (appName: string) => {
    const newList = normalizeManualApps([...manualApps, appName]);
    if (areStringArraysEqual(newList, manualApps)) return;
    setManualApps(newList);
    await saveSetting("manual_apps", newList, () => setManualApps(manualApps));
  }

  const removeApp = async (app: string) => {
    const normalizedApp = String(app).trim();
    const newList = normalizeManualApps(manualApps.filter(a => a !== normalizedApp));
    setManualApps(newList);
    await saveSetting("manual_apps", newList, () => setManualApps(manualApps));
  }

  const openAppMenu = () => {
    setShowAppMenu(true);
    refreshAppMenuData();
  }

  const openDiagnostics = () => {
    setShowDiagnostics(true);
    void refreshDiagnostics();
  }

  const inhibitAppCount = manualApps.length;

  if (showAppMenu) {
    return (
      <InhibitAppsPage
        manualApps={manualApps}
        inhibitStatus={inhibitStatus}
        deckyMusicActive={deckyMusicActive}
        runningProcesses={runningProcesses}
        refreshing={refreshing}
        onBack={() => setShowAppMenu(false)}
        onRefresh={refreshAppMenuData}
        onAddApp={addApp}
        onRemoveApp={removeApp}
      />
    );
  }

  if (showDiagnostics) {
    return (
      <DiagnosticsPage
        diagnostics={diagnostics}
        loading={diagnosticsLoading}
        exportStatus={diagnosticsExportStatus}
        onBack={() => setShowDiagnostics(false)}
        onRefresh={refreshDiagnostics}
        onExport={exportDiagnostics}
      />
    );
  }

  return (
    <PanelLayout>
      <PanelSection title={t('Plugin Controls')}>
        <PanelSectionRow>
          <ToggleField
            label={t('Background Monitor')}
            description={t('plugin_switch_tip')}
            onChange={async (checked) => {
              const previous = running;
              setRunning(checked)
              backendState.SetState(checked ? 1 : 0)
              if (!await saveSetting(RUN_ON_LOGIN, checked, () => {
                setRunning(previous)
                backendState.SetState(previous ? 1 : 0)
              })) return;

              try {
                const succeeded = checked ? await startBackend() : await stopBackend();
                if (succeeded !== true) throw new Error("backend lifecycle RPC failed");
                await onMonitorChanged();
                notifyMonitorStatus(checked);
              } catch {
                setRunning(previous)
                backendState.SetState(previous ? 1 : 0)
                await setPluginSetting(serverApi, RUN_ON_LOGIN, previous);
                serverApi.toaster.toast({
                  title: t("Background Monitor Failed"),
                  body: t("Settings Save Failed Body"),
                  icon: <GiNightSleep />,
                  critical: true,
                  duration: 4000,
                });
              }
            }}
            checked={running}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label={t('Show Notify')}
            description={t('notify_tip')}
            onChange={async (checked) => {
              const previous = notify;
              setNotify(checked)
              showNotify = checked
              await saveSetting(SHOW_NOTIFY, checked, () => {
                setNotify(previous)
                showNotify = previous
              });
            }}
            checked={notify}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('Power Profiles')}>
        <style>{`
          .ScreenSaverEnhancements_PowerConfigCollapse > div > div > div > button,
          .ScreenSaverEnhancements_PowerConfigCollapse > div > div > div > div > button {
            height: 10px !important;
          }
        `}</style>
        <PanelSectionRow>
          <div style={{
            fontSize: '14px',
            fontWeight: 'bold',
            marginTop: '8px',
            marginBottom: '6px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
            paddingBottom: '3px',
            color: 'white',
          }}>
            {t('Custom Power Configuration')}
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div className="ScreenSaverEnhancements_PowerConfigCollapse" style={{ marginTop: '-2px', marginBottom: '4px' }}>
            <ButtonItem
              layout="below"
              bottomSeparator={powerConfigCollapsed ? "standard" : "none"}
              onClick={() => setPowerConfigCollapsed(!powerConfigCollapsed)}
            >
              {powerConfigCollapsed
                ? <RiArrowDownSFill style={{ transform: 'translate(0, -13px)', fontSize: '1.5em' }} />
                : <RiArrowUpSFill style={{ transform: 'translate(0, -12px)', fontSize: '1.5em' }} />}
            </ButtonItem>
          </div>
        </PanelSectionRow>
        {!powerConfigCollapsed && <>
          <PanelSectionRow>
            <SliderField
              value={secondsToMinutes(powerSettings.batteryDim)}
              min={0}
              max={60}
              step={1}
              showValue={true}
              valueSuffix={t('Minutes')}
              label={t('Battery Dim Timeout')}
              description={t('Zero Disables Timeout')}
              onChange={(value) => void updatePowerSetting('batteryDim', minutesToSeconds(value))}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <SliderField
              value={secondsToMinutes(powerSettings.acDim)}
              min={0}
              max={60}
              step={1}
              showValue={true}
              valueSuffix={t('Minutes')}
              label={t('AC Dim Timeout')}
              description={t('Zero Disables Timeout')}
              onChange={(value) => void updatePowerSetting('acDim', minutesToSeconds(value))}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <SliderField
              value={secondsToMinutes(powerSettings.batterySuspend)}
              min={0}
              max={60}
              step={1}
              showValue={true}
              valueSuffix={t('Minutes')}
              label={t('Battery Suspend Timeout')}
              description={t('Zero Disables Timeout')}
              onChange={(value) => void updatePowerSetting('batterySuspend', minutesToSeconds(value))}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <SliderField
              value={secondsToMinutes(powerSettings.acSuspend)}
              min={0}
              max={60}
              step={1}
              showValue={true}
              valueSuffix={t('Minutes')}
              label={t('AC Suspend Timeout')}
              description={t('Zero Disables Timeout')}
              onChange={(value) => void updatePowerSetting('acSuspend', minutesToSeconds(value))}
            />
          </PanelSectionRow>
        </>}
      </PanelSection>

      <PanelSection title={t('Black Background Section')}>
        <PanelSectionRow>
          <ToggleField
            label={t('Black Background')}
            description={renderBlackBackgroundTip()}
            onChange={async (checked) => {
              const previous = blackBackground;
              setBlackBackground(checked)
              overlayState.SetState(checked ? 1 : 0)
              if (!await saveSetting(BLACK_BACKGROUND_ENABLED, checked, () => {
                setBlackBackground(previous)
                overlayState.SetState(previous ? 1 : 0)
              })) return;
              if (checked) {
                Navigation.CloseSideMenus()
              }
            }}
            checked={blackBackground}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            value={Math.round(blackBackgroundOpacity * 100)}
            min={0}
            max={100}
            step={5}
            showValue={true}
            valueSuffix="%"
            label={t('Black Opacity')}
            description={t('black_opacity_tip')}
            onChange={(value) => {
              const normalizedOpacity = Math.min(1, Math.max(0, value / 100));
              setBlackBackgroundOpacity(normalizedOpacity);
              opacityState.SetState(normalizedOpacity);
              scheduleOpacitySave(normalizedOpacity);
            }}
          />
        </PanelSectionRow>
        {closeOnAnyKeyLoaded && (
          <PanelSectionRow>
            <ToggleField
              label={t('Close On Any Key')}
              description={t('close_anykey_tip')}
              onChange={async (checked) => {
                const previous = closeOnAnyKey;
                setCloseOnAnyKey(checked)
                await saveSetting(BLACK_BACKGROUND_CLOSE_ON_ANY_KEY, checked, () => {
                  setCloseOnAnyKey(previous)
                });
              }}
              checked={closeOnAnyKey}
            />
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title={t('Update')}>
        <PanelSectionRow>
          <div style={PANEL_STYLES.updateSummary}>
            <div style={PANEL_STYLES.updateVersionRow}>
              <span style={PANEL_STYLES.updateVersionLabel}>{t('Current Version')}</span>
              <span style={PANEL_STYLES.updateVersionValue}>{pluginVersion || '-'}</span>
            </div>
            <div style={PANEL_STYLES.updateVersionRow}>
              <span style={PANEL_STYLES.updateVersionLabel}>{t('Latest Version')}</span>
              <span style={PANEL_STYLES.updateVersionValue}>{latestVersion || '-'}</span>
            </div>
          </div>
        </PanelSectionRow>
        {updateAvailable && (
          <PanelSectionRow>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%' }}>
              <div style={PANEL_STYLES.sectionHint}>{t('Release Notes')}</div>
              <div style={PANEL_STYLES.releaseNotes}>{updateNotes || t('No Release Notes')}</div>
            </div>
          </PanelSectionRow>
        )}
        {updateAvailable && (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={installingUpdate || !updateDownloadUrl || !updateSha256}
              onClick={() => void installUpdate()}
            >
              {installingUpdate ? t('Installing Update') : t('Download and Install')}
            </ButtonItem>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={checkingUpdate}
            onClick={() => void checkUpdate()}
          >
            {checkingUpdate ? t('Checking') : t('Check Update')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('App Rules Section')}>
        <PanelSectionRow>
          <Focusable
            style={PANEL_STYLES.menuItem}
            onClick={openAppMenu}
          >
            <div style={PANEL_STYLES.menuMain}>
              <span style={PANEL_STYLES.menuIcon}>☾</span>
              <div style={PANEL_STYLES.menuText}>
                <span style={PANEL_STYLES.menuTitle}>{t('Inhibit Apps')}</span>
                <span style={PANEL_STYLES.menuDescription}>{t('app_rules_tip')}</span>
              </div>
            </div>
            <div style={PANEL_STYLES.menuTrailing}>
              {inhibitAppCount > 0 && (
                <span style={PANEL_STYLES.countBadge}>{inhibitAppCount}</span>
              )}
              <span style={PANEL_STYLES.chevron}>›</span>
            </div>
          </Focusable>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('Diagnostics Section')}>
        <PanelSectionRow>
          <Focusable style={PANEL_STYLES.menuItem} onClick={openDiagnostics}>
            <div style={PANEL_STYLES.menuMain}>
              <span style={PANEL_STYLES.menuIcon}>i</span>
              <div style={PANEL_STYLES.menuText}>
                <span style={PANEL_STYLES.menuTitle}>{t('Diagnostics')}</span>
                <span style={PANEL_STYLES.menuDescription}>{t('diagnostics_tip')}</span>
              </div>
            </div>
            <span style={PANEL_STYLES.chevron}>›</span>
          </Focusable>
        </PanelSectionRow>
      </PanelSection>
    </PanelLayout>
  );
};


export default definePlugin(() => {
  const backendState = new StateNumber(0);
  const overlayState = new StateNumber(0);
  const opacityState = new StateNumber(1);
  const deckyMusicState = new StateNumber(0);
  let configuredPowerSettings: PowerSettings = { ...DEFAULT_POWER_SETTINGS };
  let backendInhibiting = false;
  let deckyMusicInhibiting = false;

  const setConfiguredPowerSettings = (settings: PowerSettings) => {
    configuredPowerSettings = { ...settings };
  }

  let SettingDef = {
    battery_idle: {
      field: 1,
      wireType: 5
    },
    ac_idle: {
      field: 2,
      wireType: 5
    },
    battery_suspend: {
      field: 3,
      wireType: 5
    },
    ac_suspend: {
      field: 4,
      wireType: 5
    },
  }

  const _updateSettings = async (data: string) => {
    await SteamClient.System.UpdateSettings(window.btoa(data))
  }
  let updateIdleSetting = _updateSettings;
  let updateSuspendSetting = _updateSettings;

  // SteamClient023 uses the newer suspend setting fields.
  if (!SteamClient.System.RegisterForOnSuspendRequest) {
    SettingDef.battery_suspend = {
      field: 24003,
      wireType: 0
    }
    SettingDef.ac_suspend = {
      field: 24004,
      wireType: 0
    }
    updateSuspendSetting = async (data: string) => {
      await SteamClient.Settings.SetSetting(window.btoa(data))
    };
  }

  /**
   * Protobuf setting generation
   * @param field 1:battery_idle; 2:ac_idle; 3/24003:battery_suspend; 4/24004:ac_suspend
   * @param value 0 for disable (seconds)
   * @param wireType 0 for int32, 5 for float
   * @returns settings in binary string
   */
  function genSettings(field: any, value: number) {
    const buf = [];

    let key = (field.field << 3) | field.wireType;
    do {
      let b = key & 0x7F;
      key >>>= 7;
      if (key) b |= 0x80;
      buf.push(b);
    } while (key);

    if (field.wireType === 0) {
      do {
        let b = value & 0x7F;
        value >>>= 7;
        if (value) b |= 0x80;
        buf.push(b);
      } while (value);
      return String.fromCharCode(...buf);
    } else if (field.wireType === 5) {
      const valueBytes = new Uint8Array(new Float32Array([value]).buffer);
      return String.fromCharCode(...buf, ...valueBytes);
    } else {
      throw new Error('Unsupported wire type');
    }
  }

  async function updateSetting(battery_idle: number, ac_idle: number, battery_suspend: number, ac_suspend: number) {
    let _battery_idle = genSettings(SettingDef.battery_idle, battery_idle);
    let _ac_idle = genSettings(SettingDef.ac_idle, ac_idle);
    let _battery_suspend = genSettings(SettingDef.battery_suspend, battery_suspend);
    let _ac_suspend = genSettings(SettingDef.ac_suspend, ac_suspend);
    await updateIdleSetting(_battery_idle+_ac_idle);
    await updateSuspendSetting(_battery_suspend+_ac_suspend);
  }

  const readSystemPowerSettings = async (): Promise<PowerSettings | null> => {
    try {
      const inhibitStatus = await serverApi.getInhibitStatus();
      const result = await serverApi.getSystemPowerSettings();
      const systemSettings = parseSteamPowerSettings(result);
      if (!systemSettings) return null;

      const isInhibiting = Boolean(inhibitStatus.is_inhibiting || deckyMusicInhibiting);
      return shouldSyncSystemPowerSettings(systemSettings, isInhibiting) ? systemSettings : null;
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not read current power settings", error);
      return null;
    }
  }

  const getPowerOverrideState = async (): Promise<PowerOverrideState> => {
    try {
      return parsePowerOverrideState(await serverApi.getPowerOverrideState());
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not read power recovery state", error);
      return { active: false, snapshot: null };
    }
  }

  const beginPowerOverride = async (snapshot: PowerSettings) => {
    try {
      return await serverApi.beginPowerOverride(snapshot) === true;
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not save power recovery state", error);
      return false;
    }
  }

  const endPowerOverride = async () => {
    try {
      return await serverApi.endPowerOverride() === true;
    } catch (error) {
      console.warn("[ScreenSaverEnhancements] Could not clear power recovery state", error);
      return false;
    }
  }

  const restorePendingPowerOverride = async () => {
    const state = await getPowerOverrideState();
    if (!state.active || !state.snapshot) return false;

    await updateSetting(
      state.snapshot.batteryDim,
      state.snapshot.acDim,
      state.snapshot.batterySuspend,
      state.snapshot.acSuspend,
    );
    setConfiguredPowerSettings(state.snapshot);
    const cleared = await endPowerOverride();
    if (!cleared) {
      console.warn("[ScreenSaverEnhancements] Power settings restored, but recovery state could not be cleared");
    }
    return cleared;
  }

  const applyConfiguredPowerSettings = async (settings: PowerSettings) => {
    const isInhibiting = !shouldApplyPowerSettingsImmediately(backendInhibiting, deckyMusicInhibiting);
    if (!isInhibiting) {
      await updateSetting(
        settings.batteryDim,
        settings.acDim,
        settings.batterySuspend,
        settings.acSuspend,
      );
    }
    setConfiguredPowerSettings(settings);
  }

  const isDeckyMusicEnabled = (apps: string[]) => {
    return apps.some(app => app.toLowerCase() === DECKY_MUSIC_APP.toLowerCase());
  }

  type AudioTracker = {
    elements: Set<HTMLMediaElement>;
    dispose: () => void;
  };

  const installAudioTracker = (onStateChanged: () => void): AudioTracker => {
    const trackerKey = "__screensaverEnhancementsAudioTrackerV2";
    const existingTracker = (window as any)[trackerKey] as AudioTracker | undefined;
    if (existingTracker) return existingTracker;

    const tracked = new Set<HTMLMediaElement>();
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalPause = HTMLMediaElement.prototype.pause;

    const handlePause = function(this: HTMLMediaElement) {
      tracked.delete(this);
      onStateChanged();
    };

    const handleEnded = function(this: HTMLMediaElement) {
      tracked.delete(this);
      onStateChanged();
    };

    const trackedPlay = function(this: HTMLMediaElement) {
      tracked.add(this);
      this.addEventListener("pause", handlePause, { once: true });
      this.addEventListener("ended", handleEnded, { once: true });
      onStateChanged();
      return originalPlay.apply(this);
    };

    const trackedPause = function(this: HTMLMediaElement) {
      tracked.delete(this);
      onStateChanged();
      return originalPause.apply(this);
    };

    HTMLMediaElement.prototype.play = trackedPlay;
    HTMLMediaElement.prototype.pause = trackedPause;

    document.querySelectorAll("audio,video").forEach((element) => {
      const mediaElement = element as HTMLMediaElement;
      if (!mediaElement.paused && !mediaElement.ended) {
        tracked.add(mediaElement);
        mediaElement.addEventListener("pause", handlePause, { once: true });
        mediaElement.addEventListener("ended", handleEnded, { once: true });
      }
    });

    const tracker: AudioTracker = {
      elements: tracked,
      dispose: () => {
        tracked.forEach((mediaElement) => {
          mediaElement.removeEventListener("pause", handlePause);
          mediaElement.removeEventListener("ended", handleEnded);
        });
        tracked.clear();
        if (HTMLMediaElement.prototype.play === trackedPlay) {
          HTMLMediaElement.prototype.play = originalPlay;
        }
        if (HTMLMediaElement.prototype.pause === trackedPause) {
          HTMLMediaElement.prototype.pause = originalPause;
        }
        if ((window as any)[trackerKey] === tracker) {
          delete (window as any)[trackerKey];
        }
      },
    };
    (window as any)[trackerKey] = tracker;
    return tracker;
  }

  let audioTracker: AudioTracker | null = null;

  const ensureAudioTracker = (onStateChanged: () => void) => {
    if (!audioTracker) {
      audioTracker = installAudioTracker(onStateChanged);
    }
    return audioTracker.elements;
  }

  const disposeAudioTracker = () => {
    audioTracker?.dispose();
    audioTracker = null;
  }

  const isAnyAudioPlaying = () => {
    const trackedAudioElements = audioTracker?.elements;
    if (!trackedAudioElements || trackedAudioElements.size === 0) return false;

    for (const audio of trackedAudioElements) {
      if (audio.src && !audio.paused && !audio.ended && audio.readyState > HTMLMediaElement.HAVE_NOTHING) {
        return true;
      }
    }

    return false;
  }

  let timeout:NodeJS.Timeout;
  const notify = (title: string, body: string) => {
    if (!showNotify) return
    clearTimeout(timeout)
    timeout = setTimeout(()=>{
      serverApi.toaster.toast({
        title: title,
        body: body,
        duration: 1_500,
        sound: 1,
        icon: <GiNightSleep />,
      });
    }, 2000)
  }

  const activateInhibit = async (
    snapshot: PowerSettings,
    application?: string,
    showNotification = true,
  ) => {
    const displayName = getAppDisplayName(application);
    const message = displayName ? `${displayName} ${t("Inhibit")}` : t("Inhibit");
    if (!await beginPowerOverride(snapshot)) {
      throw new Error("Could not save the power override recovery snapshot");
    }
    setConfiguredPowerSettings(snapshot);
    try {
      await updateSetting(0, 0, 0, 0);
      if (showNotification) {
        notify(t("ScreenSaver"), message)
      }
    } catch (error) {
      await endPowerOverride();
      throw error;
    }
  }

  const startInhibit = async (application?: string) => {
    const snapshot = await readSystemPowerSettings() ?? configuredPowerSettings;
    await activateInhibit(snapshot, application);
  }

  const stopInhibit = async (
    showRestoreNotification = true,
    knownState?: PowerOverrideState,
  ) => {
    const state = knownState ?? await getPowerOverrideState();
    const restoreSettings = state.snapshot ?? configuredPowerSettings;
    await updateSetting(
      restoreSettings.batteryDim,
      restoreSettings.acDim,
      restoreSettings.batterySuspend,
      restoreSettings.acSuspend,
    );
    setConfiguredPowerSettings(restoreSettings);
    if (state.active) {
      await endPowerOverride();
    }
    if (showRestoreNotification) {
      notify(t("ScreenSaver"), t("UnInhibit"))
    }
  }

  let deckyMusicEnabled = false;
  let pluginActive = true;
  let unsubscribeSettingsChanged: (() => void) | null = null;
  let unsubscribeInhibitStateChanged: (() => void) | null = null;
  const pushListenerHealth = createPushListenerHealth();
  const eventChannelDiagnostics: Pick<
    EventChannelDiagnostics,
    'lastFullSyncAt' | 'lastFullSyncSuccessful'
  > = {
    lastFullSyncAt: null,
    lastFullSyncSuccessful: null,
  };
  let powerOperation = Promise.resolve();

  const enqueuePowerOperation = (operation: () => Promise<void>) => {
    const operationResult = powerOperation.then(operation);
    powerOperation = operationResult
      .catch((error) => console.error("[ScreenSaverEnhancements] Power state update failed", error));
    return operationResult;
  }

  const reconcileDeckyMusicState = async () => {
    const deckyMusicPlaying = deckyMusicEnabled && isAnyAudioPlaying();
    if (deckyMusicPlaying && !deckyMusicInhibiting) {
      const shouldStart = shouldStartInhibit(backendInhibiting, deckyMusicInhibiting);
      deckyMusicInhibiting = true;
      deckyMusicState.SetState(1);
      if (shouldStart) {
        await startInhibit(DECKY_MUSIC_APP);
      }
    } else if (!deckyMusicPlaying && deckyMusicInhibiting) {
      deckyMusicInhibiting = false;
      deckyMusicState.SetState(0);
      if (!backendInhibiting) {
        await stopInhibit();
      }
    }
  }

  const scheduleDeckyMusicReconciliation = () => {
    enqueuePowerOperation(reconcileDeckyMusicState);
  }

  const refreshDeckyMusicSetting = async (
    reconcilePower = true,
    monitorRunning = backendState.GetState() === 1,
  ) => {
    const manualApps = await getPluginSetting(serverApi, "manual_apps", []);
    deckyMusicEnabled = monitorRunning
      && isDeckyMusicEnabled(normalizeManualApps(manualApps));
    if (deckyMusicEnabled) {
      ensureAudioTracker(scheduleDeckyMusicReconciliation);
    } else {
      disposeAudioTracker();
    }
    if (reconcilePower) {
      await reconcileDeckyMusicState();
    } else {
      deckyMusicInhibiting = deckyMusicEnabled && isAnyAudioPlaying();
      deckyMusicState.SetState(deckyMusicInhibiting ? 1 : 0);
    }
  }

  const synchronizeRuntimeState = async (showStateNotification = false) => {
    try {
      const [running, inhibitStatus, rawOverrideState, rawSystemSettings] = await Promise.all([
        serverApi.isRunning(),
        serverApi.getInhibitStatus(),
        serverApi.getPowerOverrideState(),
        serverApi.getSystemPowerSettings(),
      ]);
      const overrideState = parsePowerOverrideState(rawOverrideState);
      const systemSettings = parseSteamPowerSettings(rawSystemSettings);
      const activeApplication = inhibitStatus.manual_active_app
        ?? inhibitStatus.dbus_requests[0]?.application;
      const notifyStateChange = showStateNotification && running;

      backendState.SetState(running ? 1 : 0);
      backendInhibiting = running && inhibitStatus.is_inhibiting;
      await refreshDeckyMusicSetting(false, running);

      if (overrideState.active && overrideState.snapshot) {
        setConfiguredPowerSettings(overrideState.snapshot);
      }
      const shouldBeInhibiting = backendInhibiting || deckyMusicInhibiting;
      const action = getPowerSyncAction(shouldBeInhibiting, overrideState, systemSettings);
      if (action === "start") {
        const snapshot = systemSettings && shouldSyncSystemPowerSettings(systemSettings, true)
          ? systemSettings
          : configuredPowerSettings;
        await activateInhibit(snapshot, activeApplication, notifyStateChange);
      } else if (action === "reapply") {
        await updateSetting(0, 0, 0, 0);
      } else if (action === "restore") {
        await stopInhibit(notifyStateChange, overrideState);
      }
      eventChannelDiagnostics.lastFullSyncAt = Math.floor(Date.now() / 1000);
      eventChannelDiagnostics.lastFullSyncSuccessful = true;
    } catch (error) {
      eventChannelDiagnostics.lastFullSyncAt = Math.floor(Date.now() / 1000);
      eventChannelDiagnostics.lastFullSyncSuccessful = false;
      throw error;
    }
  }

  const disconnectPushListeners = () => {
    unsubscribeSettingsChanged?.();
    unsubscribeSettingsChanged = null;
    unsubscribeInhibitStateChanged?.();
    unsubscribeInhibitStateChanged = null;
    pushListenerHealth.markDisconnected();
  }

  const reconnectPushListeners = (synchronizeAfterConnect = false) => {
    if (!pluginActive) return;
    disconnectPushListeners();
    try {
      unsubscribeSettingsChanged = serverApi.subscribeSettingsChanged(() => {
        if (!pluginActive) return;
        enqueuePowerOperation(() => refreshDeckyMusicSetting())
          .catch(() => reconnectPushListeners(true));
      });
      unsubscribeInhibitStateChanged = serverApi.subscribeInhibitStateChanged(() => {
        if (!pluginActive) return;
        enqueuePowerOperation(() => synchronizeRuntimeState(true))
          .catch(() => reconnectPushListeners(true));
      });
      pushListenerHealth.markConnected();
      if (synchronizeAfterConnect) {
        enqueuePowerOperation(() => synchronizeRuntimeState())
          .catch((syncError) => console.error(
            "[ScreenSaverEnhancements] Could not synchronize after reconnecting push listeners",
            syncError,
          ));
      }
    } catch (error) {
      disconnectPushListeners();
      console.error("[ScreenSaverEnhancements] Could not connect push listeners", error);
    }
  }

  const initializePlugin = async () => {
    try {
      const blackBackground = await getPluginBooleanSetting(serverApi, BLACK_BACKGROUND_ENABLED, false)
      if (blackBackground) {
        overlayState.SetState(1)
      }

      const blackOpacity = await getPluginNumberSetting(serverApi, BLACK_BACKGROUND_OPACITY, 1)
      opacityState.SetState(clampOpacity(blackOpacity))

      showNotify = await getPluginBooleanSetting(serverApi, SHOW_NOTIFY, false)

      const [batteryDim, acDim, batterySuspend, acSuspend] = await Promise.all([
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.batteryDim, DEFAULT_POWER_SETTINGS.batteryDim),
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.acDim, DEFAULT_POWER_SETTINGS.acDim),
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.batterySuspend, DEFAULT_POWER_SETTINGS.batterySuspend),
        getPluginNumberSetting(serverApi, POWER_SETTING_KEYS.acSuspend, DEFAULT_POWER_SETTINGS.acSuspend),
      ])
      setConfiguredPowerSettings(normalizePowerSettings({
        batteryDim,
        acDim,
        batterySuspend,
        acSuspend,
      }))

    } catch (error) {
      backendState.SetState(0)
      console.error("[ScreenSaverEnhancements] Plugin initialization failed", error)
    } finally {
      if (pluginActive) {
        try {
          await synchronizeRuntimeState();
        } catch (error) {
          console.error("[ScreenSaverEnhancements] Could not synchronize runtime state", error)
        }
        reconnectPushListeners();
      }
    }
  }

  void initializePlugin();

  serverApi.routerHook.addGlobalComponent(
    "ScreenSaverEnhancementsBlackOverlay",
    () => <BlackOverlay serverApi={serverApi} overlayState={overlayState} opacityState={opacityState} />
  );

  return {
    name: "屏幕保护增强",
    titleView: <div className={staticClasses.Title}>Suspend Manager</div>,
    content: <Content
      serverApi={serverApi}
      backendState={backendState}
      overlayState={overlayState}
      opacityState={opacityState}
      deckyMusicState={deckyMusicState}
      onPowerSettingsLoaded={setConfiguredPowerSettings}
      onPowerSettingsApply={applyConfiguredPowerSettings}
      readSystemPowerSettings={readSystemPowerSettings}
      onMonitorChanged={() => enqueuePowerOperation(() => synchronizeRuntimeState())}
      getEventChannelDiagnostics={() => ({
        ...pushListenerHealth.snapshot(),
        ...eventChannelDiagnostics,
      })}
    />,
    icon: <GiNightSleep />,
    onDismount() {
      void restorePendingPowerOverride()
      deckyMusicState.SetState(0)
      clearTimeout(timeout)
      pluginActive = false
      disconnectPushListeners()
      disposeAudioTracker()
      serverApi.routerHook.removeGlobalComponent("ScreenSaverEnhancementsBlackOverlay")
    },
  };
});
