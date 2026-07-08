import {
  definePlugin,
  ToggleField,
  SliderField,
  PanelSection,
  PanelSectionRow,
  Navigation,
  ServerAPI,
  findModuleChild,
  Module,
  staticClasses,
  Focusable,
} from "decky-frontend-lib";
import React, { VFC } from "react";
import { useState, useEffect, useRef } from 'react'
import { GiNightSleep } from "react-icons/gi";
import i18n from './i18n'
import { BlackOverlay, BLACK_BACKGROUND_CLOSE_ON_ANY_KEY, BLACK_BACKGROUND_ENABLED, BLACK_BACKGROUND_OPACITY } from './blackOverlay'
import { QUICK_ACCESS_MENU } from './ButtonIcons'
import { StateNumber } from './state'
import { clampOpacity, parseBooleanSetting, setPluginSetting } from './settingsClient'

let backendRunning = false;
let showNotify     = false;
let language = i18n.getCurrentLanguage()
const t = i18n.useTranslations(language)

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

const PanelLayout: VFC<{ children: React.ReactNode }> = ({ children }) => React.createElement(
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

const findModule = (property: string) => {
  return findModuleChild((m: Module) => {
    if (typeof m !== "object") return undefined;
    for (let prop in m) {
      try {
        if (m[prop][property]) {
          return m[prop];
        }
      } catch (e) {
        return undefined;
      }
    }
  });
}
const SystemSleep = findModule("InitiateSleep")

const RUN_ON_LOGIN = "run_on_login"
const SHOW_NOTIFY  = "show_notify"
const DECKY_MUSIC_APP = "DeckyMusic"

type RunningProcess = { name: string, type: string };

type InhibitAppsPageProps = {
  manualApps: string[];
  runningProcesses: RunningProcess[];
  refreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onAddApp: (appName: string) => void;
  onRemoveApp: (appName: string) => void;
};

const InhibitAppsPage: VFC<InhibitAppsPageProps> = ({
  manualApps,
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

const Content: VFC<{
  serverApi: ServerAPI;
  overlayState: StateNumber;
  opacityState: StateNumber;
}> = ({serverApi, overlayState, opacityState}) => {
  const [running, setRunning] = useState<boolean>(backendRunning);
  const [notify, setNotify] = useState<boolean>(showNotify);
  const [blackBackground, setBlackBackground] = useState<boolean>(overlayState.GetState() === 1);
  const [blackBackgroundOpacity, setBlackBackgroundOpacity] = useState<number>(opacityState.GetState());
  const [closeOnAnyKey, setCloseOnAnyKey] = useState<boolean>(false);

  const startBackend = async () => {
    return await serverApi.callPluginMethod<any, any>("start_backend", {});
  }

  const stopBackend = async () => {
    return await serverApi.callPluginMethod<any, any>("stop_backend", {});
  }

  const setSettings = async (key: string, value: any) => {
    return await setPluginSetting(serverApi, key, value);
  }
  const [manualApps, setManualApps] = useState<string[]>([]);
  const [runningProcesses, setRunningProcesses] = useState<RunningProcess[]>([]);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [showAppMenu, setShowAppMenu] = useState<boolean>(false);
  const panelVisible = useRef(true);

  const fetchRunningProcesses = async () => {
    if (!panelVisible.current) return;
    setRefreshing(true);
    try {
      const res = await serverApi.callPluginMethod<any, any>("get_running_processes", {});
      if (res.success) {
        setRunningProcesses(res.result);
      }
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    panelVisible.current = true;
    const fetchManualApps = async () => {
      const res = await getSettings("manual_apps", []);
      if (res.success && res.result && res.result.length > 0) {
        setManualApps(res.result);
      } else if (res.success && (res.result === null || res.result.length === 0)) {
        // Pre-populate defaults if empty
        const defaults = ["chrome", "mpv", "wiliwili"];
        setManualApps(defaults);
        await setSettings("manual_apps", defaults);
      }
    };
    fetchManualApps();
    fetchRunningProcesses();
    const interval = setInterval(fetchRunningProcesses, 30000);

    const loadBlackBackgroundSettings = async () => {
      const [enabledRes, opacityRes, closeOnAnyKeyRes] = await Promise.all([
        getSettings(BLACK_BACKGROUND_ENABLED, false),
        getSettings(BLACK_BACKGROUND_OPACITY, 1),
        getSettings(BLACK_BACKGROUND_CLOSE_ON_ANY_KEY, false),
      ]);
      if (enabledRes.success) {
        const enabled = parseBooleanSetting(enabledRes.result, false);
        setBlackBackground(enabled);
        overlayState.SetState(enabled ? 1 : 0);
      }
      if (opacityRes.success) {
        const opacity = clampOpacity(Number(opacityRes.result));
        setBlackBackgroundOpacity(opacity);
        opacityState.SetState(opacity);
      }
      if (closeOnAnyKeyRes.success) {
        setCloseOnAnyKey(parseBooleanSetting(closeOnAnyKeyRes.result, false));
      }
    };
    loadBlackBackgroundSettings();

    const onOverlayChanged = (mode: number) => {
      setBlackBackground(mode === 1);
    };
    const onOpacityChanged = (value: number) => {
      setBlackBackgroundOpacity(Math.min(1, Math.max(0, value)));
    };
    overlayState.onStateChanged(onOverlayChanged);
    opacityState.onStateChanged(onOpacityChanged);

    return () => {
      panelVisible.current = false;
      clearInterval(interval);
      overlayState.offStateChanged(onOverlayChanged);
      opacityState.offStateChanged(onOpacityChanged);
    };
  }, [overlayState, opacityState]);

  const getSettings = async (key: string, defaults: any) => {
    return await serverApi.callPluginMethod<any, any>("get_settings", {key: key, defaults: defaults});
  }

  const addApp = async (appName: string) => {
    if (!appName || manualApps.includes(appName)) return;
    const newList = [...manualApps, appName];
    setManualApps(newList);
    await setSettings("manual_apps", newList);
  }

  const removeApp = async (app: string) => {
    const newList = manualApps.filter(a => a !== app);
    setManualApps(newList);
    await setSettings("manual_apps", newList);
  }

  const openAppMenu = () => {
    setShowAppMenu(true);
    fetchRunningProcesses();
  }

  if (showAppMenu) {
    return (
      <InhibitAppsPage
        manualApps={manualApps}
        runningProcesses={runningProcesses}
        refreshing={refreshing}
        onBack={() => setShowAppMenu(false)}
        onRefresh={fetchRunningProcesses}
        onAddApp={addApp}
        onRemoveApp={removeApp}
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
              setRunning(checked)
              backendRunning = checked
              await setSettings(RUN_ON_LOGIN, checked)
              checked ? await startBackend() : await stopBackend() 
            }}
            checked={running}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label={t('Show Notify')}
            description={t('notify_tip')}
            onChange={async (checked) => {
              setNotify(checked)
              showNotify = checked
              await setSettings(SHOW_NOTIFY, checked)
            }}
            checked={notify}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t('Black Background Section')}>
        <PanelSectionRow>
          <ToggleField
            label={t('Black Background')}
            description={renderBlackBackgroundTip()}
            onChange={async (checked) => {
              setBlackBackground(checked)
              overlayState.SetState(checked ? 1 : 0)
              await setSettings(BLACK_BACKGROUND_ENABLED, checked)
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
              void setSettings(BLACK_BACKGROUND_OPACITY, normalizedOpacity);
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label={t('Close On Any Key')}
            description={t('close_anykey_tip')}
            onChange={async (checked) => {
              setCloseOnAnyKey(checked)
              await setSettings(BLACK_BACKGROUND_CLOSE_ON_ANY_KEY, checked)
            }}
            checked={closeOnAnyKey}
          />
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
              {manualApps.length > 0 && (
                <span style={PANEL_STYLES.countBadge}>{manualApps.length}</span>
              )}
              <span style={PANEL_STYLES.chevron}>›</span>
            </div>
          </Focusable>
        </PanelSectionRow>
      </PanelSection>
    </PanelLayout>
  );
};


export default definePlugin((serverApi: ServerAPI) => {
  const overlayState = new StateNumber(0);
  const opacityState = new StateNumber(1);
  let forced_suspend:NodeJS.Timeout;
  let forced_suspend_tip:NodeJS.Timeout;
  let input_changed:boolean = true;

  const clearSuspendTimeout = () => {
    clearTimeout(forced_suspend)
    clearTimeout(forced_suspend_tip)
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

  // SteamClient version 1759461205 does not have `RegisterForControllerStateChanges`
  let controllerHandle: any = null;
  controllerHandle =
    SteamClient.Input.RegisterForControllerStateChanges &&
    SteamClient.Input.RegisterForControllerStateChanges (
    (changes: any[]) => {
      if (input_changed) return
      for (const inputs of changes) {
        const { ulButtons, sLeftStickX, sLeftStickY, sRightStickX, sRightStickY, } = inputs;
        if (ulButtons != 0) { input_changed = true; }
        if (Math.abs(sLeftStickX) > 5000 || Math.abs(sLeftStickY) > 5000 ||
            Math.abs(sRightStickX) > 5000 || Math.abs(sRightStickY) > 5000) {
              input_changed = true;
        }
      }
      if (input_changed) {
        clearSuspendTimeout()
      }
    }
  );
  if (!controllerHandle) {
    controllerHandle = SteamClient.Input.RegisterForControllerInputMessages(
      () => {
        if (input_changed) return
        input_changed = true
        clearSuspendTimeout()
      }
    );
  }

  // SteamClient023 does not have `RegisterForOnSuspendRequest`
  let suspendHandle: any = null
  suspendHandle =
    SteamClient.System.RegisterForOnSuspendRequest && 
    SteamClient.System.RegisterForOnSuspendRequest(clearSuspendTimeout);
  if (!suspendHandle) {
    suspendHandle = SteamClient.User.RegisterForPrepareForSystemSuspendProgress(clearSuspendTimeout);

    // SteamClient023 using new suspend settings
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
  
  const getEvent = async () => {
    return await serverApi.callPluginMethod<any, any>("get_event", {});
  }

  const getSettings = async (key: string, defaults: any) => {
    return await serverApi.callPluginMethod<any, any>("get_settings", {key: key, defaults: defaults});
  }

  const startBackend = async () => {
    return await serverApi.callPluginMethod<any, any>("start_backend", {});
  }

  const isDeckyMusicEnabled = (apps: string[]) => {
    return apps.some(app => app.toLowerCase() === DECKY_MUSIC_APP.toLowerCase());
  }

  const activeAudioElements = new Set<HTMLMediaElement>();

  const installAudioTracker = () => {
    const trackerKey = "__screensaverEnhancementsAudioTracker";
    const existingTracker = (window as any)[trackerKey];
    if (existingTracker) {
      return existingTracker as Set<HTMLMediaElement>;
    }

    const tracked = activeAudioElements;
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalPause = HTMLMediaElement.prototype.pause;

    const handlePause = function(this: HTMLMediaElement) {
      tracked.delete(this);
    };

    const handleEnded = function(this: HTMLMediaElement) {
      tracked.delete(this);
    };

    HTMLMediaElement.prototype.play = function() {
      tracked.add(this);
      this.addEventListener("pause", handlePause, { once: true });
      this.addEventListener("ended", handleEnded, { once: true });
      return originalPlay.apply(this);
    };

    HTMLMediaElement.prototype.pause = function() {
      tracked.delete(this);
      return originalPause.apply(this);
    };

    (window as any)[trackerKey] = tracked;
    return tracked;
  }

  const trackedAudioElements = installAudioTracker();

  const isAnyAudioPlaying = () => {
    if (trackedAudioElements.size === 0) return false;

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

  const startInhibit = async () => {
    notify(t("ScreenSaver"), t("Inhibit"))
    clearSuspendTimeout()
    await updateSetting(0, 0, 0, 0);
  }

  const stopInhibit = async () => {
    notify(t("ScreenSaver"), t("UnInhibit"))
    await updateSetting(300, 300, 600, 600);
    clearSuspendTimeout()
    input_changed = false
    forced_suspend = setTimeout(() => {
      forced_suspend_tip = setTimeout(()=>{
        SystemSleep.InitiateSleep()
      }, 5_000)
      serverApi.toaster.toast({
        title: t("suspend_tip_title"),
        body: t("suspend_tip_body"),
        critical: true,
        duration: 5_000,
        playSound: false,
        icon: <GiNightSleep />,
      });
    }, 450_000)
  }

  let backendInhibiting = false;
  let deckyMusicInhibiting = false;
  let deckyMusicEnabled = false;
  let deckyMusicSettingsLastChecked = 0;

  setInterval(async () => {
    const now = Date.now();
    if (now - deckyMusicSettingsLastChecked > 30000) {
      deckyMusicSettingsLastChecked = now;
      const manualApps = await getSettings("manual_apps", []);
      if (manualApps.success && Array.isArray(manualApps.result)) {
        deckyMusicEnabled = isDeckyMusicEnabled(manualApps.result);
      }
    }

    const deckyMusicPlaying = deckyMusicEnabled && isAnyAudioPlaying();
    if (deckyMusicPlaying && !deckyMusicInhibiting) {
      deckyMusicInhibiting = true;
      await startInhibit();
    } else if (!deckyMusicPlaying && deckyMusicInhibiting) {
      deckyMusicInhibiting = false;
      if (!backendInhibiting) {
        await stopInhibit();
      }
    }

    let data = await getEvent();
    if(!data.success) return;
    let event = data.result;
    for (let e of event) {
      if (e.type == 'Inhibit') {
        backendInhibiting = true;
        await startInhibit();
      } else if (e.type == 'UnInhibit') {
        backendInhibiting = false;
        if (!deckyMusicInhibiting) {
          await stopInhibit();
        }
      }
    }
  }, 3000)

  setTimeout(async () => {
    let blackBackground = await getSettings(BLACK_BACKGROUND_ENABLED, false)
    if (blackBackground.success && (blackBackground.result === true || blackBackground.result === "true")) {
      overlayState.SetState(1)
    }

    let blackOpacity = await getSettings(BLACK_BACKGROUND_OPACITY, 1)
    if (blackOpacity.success) {
      const opacity = Math.min(1, Math.max(0, Number(blackOpacity.result)));
      opacityState.SetState(Number.isNaN(opacity) ? 1 : opacity)
    }

    let notify = await getSettings(SHOW_NOTIFY, false)
    if (notify.success) {
      showNotify = notify.result
    }

    let run = await getSettings(RUN_ON_LOGIN, true)
    if (run.success && run.result) {
      backendRunning = true
      await startBackend()
    }
  }, 0);

  serverApi.routerHook.addGlobalComponent(
    "ScreenSaverEnhancementsBlackOverlay",
    () => <BlackOverlay serverApi={serverApi} overlayState={overlayState} opacityState={opacityState} />
  );

  return {
    title: <div className={staticClasses.Title}>Suspend Manager</div>,
    content: <Content serverApi={serverApi} overlayState={overlayState} opacityState={opacityState} />,
    icon: <GiNightSleep />,
    onDismount() {
      clearSuspendTimeout()
      serverApi.routerHook.removeGlobalComponent("ScreenSaverEnhancementsBlackOverlay")
    },
  };
});
