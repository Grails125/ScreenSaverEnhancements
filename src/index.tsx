import {
  definePlugin,
  ToggleField,
  PanelSection,
  PanelSectionRow,
  ServerAPI,
  findModuleChild,
  Module,
  staticClasses,
  ButtonItem,
  Focusable,
} from "decky-frontend-lib";
import React, { VFC } from "react";
import { useState, useEffect } from 'react'
import { GiNightSleep } from "react-icons/gi";
import i18n from './i18n'

let backendRunning = false;
let showNotify     = false;
let language = i18n.getCurrentLanguage()
const t = i18n.useTranslations(language)

// Premium UI Styles
const STYLES = {
  dashboardCard: {
    background: 'linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%)',
    borderRadius: '8px',
    padding: '12px 16px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flex: 1,
    boxSizing: 'border-box' as const,
  },
  dashboardCardInactive: {
    background: 'linear-gradient(135deg, #37474f 0%, #263238 100%)',
    borderRadius: '8px',
    padding: '12px 16px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flex: 1,
    boxSizing: 'border-box' as const,
  },
  statusIcon: {
    fontSize: '2.4em',
    color: 'rgba(255,255,255,0.9)',
    filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))'
  },
  badge: (type: string) => ({
    fontSize: '0.65em',
    padding: '2px 6px',
    borderRadius: '10px',
    background: type === 'app' ? 'rgba(93, 185, 255, 0.2)' : 'rgba(158, 158, 158, 0.2)',
    color: type === 'app' ? '#5db9ff' : '#bbb',
    border: `1px solid ${type === 'app' ? 'rgba(93, 185, 255, 0.3)' : 'rgba(158, 158, 158, 0.3)'}`,
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
  }),
  processItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flex: 1,
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: '6px',
    boxSizing: 'border-box' as const,
    overflow: 'hidden' as const
  }
}

const APP_NAMES: Record<string, string> = {
  "vlc": "VLC 播放器",
  "mpv": "MPV 播放器",
  "chrome": "谷歌浏览器",
  "firefox": "火狐浏览器",
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

const Content: VFC<{ serverApi: ServerAPI }> = ({serverApi}) => {
  const [running, setRunning] = useState<boolean>(backendRunning);
  const [notify, setNotify] = useState<boolean>(showNotify);

  const startBackend = async () => {
    return await serverApi.callPluginMethod<any, any>("start_backend", {});
  }

  const stopBackend = async () => {
    return await serverApi.callPluginMethod<any, any>("stop_backend", {});
  }

  const setSettings = async (key: string, value: any) => {
    return await serverApi.callPluginMethod<any, any>("set_settings", {key: key, value: value});
  }
  const [manualApps, setManualApps] = useState<string[]>([]);
  const [runningProcesses, setRunningProcesses] = useState<{name: string, type: string}[]>([]);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const fetchRunningProcesses = async () => {
    setRefreshing(true);
    const res = await serverApi.callPluginMethod<any, any>("get_running_processes", {});
    if (res.success) {
      setRunningProcesses(res.result);
    }
    setRefreshing(false);
  }

  useEffect(() => {
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
    const interval = setInterval(fetchRunningProcesses, 10000); // 10秒刷新一次
    return () => clearInterval(interval);
  }, []);

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

  return (
    <React.Fragment>
      {/* 1. Status Dashboard - Now inside a Section for alignment */}
      <PanelSection>
        <PanelSectionRow>
          <div style={running ? STYLES.dashboardCard : STYLES.dashboardCardInactive}>
            <div style={STYLES.statusIcon}>
              <GiNightSleep />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '1.05em', fontWeight: 'bold', color: 'white' }}>
                {running ? t('ScreenSaver') : t('Background Monitor')}
              </div>
              <div style={{ fontSize: '0.75em', color: 'rgba(255,255,255,0.7)', marginTop: '2px' }}>
                {running ? t('Inhibit') : t('UnInhibit')}
              </div>
            </div>
            <ToggleField
              label=""
              onChange={async (checked) => {
                setRunning(checked)
                backendRunning = checked
                await setSettings(RUN_ON_LOGIN, checked)
                checked ? await startBackend() : await stopBackend() 
              }}
              checked={running}
            />
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection>
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
      </PanelSection>

      {/* 2. Inhibit List */}
      <PanelSection title={t('Inhibit List')}>
        {manualApps.length === 0 && (
          <PanelSectionRow>
            <div style={{textAlign: 'center', color: '#666', padding: '10px', fontSize: '0.85em'}}>
              {t('manual_tip')}
            </div>
          </PanelSectionRow>
        )}
        {manualApps.map((app) => (
          <PanelSectionRow key={app}>
            <div style={STYLES.processItem}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{color: '#5db9ff', fontWeight: 'bold'}}>●</span>
                <span>{APP_NAMES[app] || app}</span>
              </div>
              <Focusable 
                style={{
                    width: '28px', 
                    height: '28px', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.1)',
                    borderRadius: '4px',
                    fontSize: '0.8em',
                    flexShrink: 0
                }} 
                onClick={() => removeApp(app)}
              >
                ✕
              </Focusable>
            </div>
          </PanelSectionRow>
        ))}
      </PanelSection>

      {/* 3. Process Scanner */}
      <PanelSection title={t('Running Processes')}>
        <PanelSectionRow>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0 12px', boxSizing: 'border-box' }}>
            <span style={{fontSize: '0.8em', color: '#888'}}>{t('Click to add')}</span>
            <Focusable 
              style={{
                  width: '28px', 
                  height: '28px', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: '4px',
                  fontSize: '0.9em',
                  flexShrink: 0
              }} 
              onClick={fetchRunningProcesses}
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
                <div style={STYLES.processItem}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{fontSize: '0.9em', color: '#eee'}}>{APP_NAMES[proc.name] || proc.name}</span>
                      <span style={STYLES.badge(proc.type)}>
                        {proc.type === 'app' ? "应用" : "系统"}
                      </span>
                    </div>
                    {APP_NAMES[proc.name] && (
                      <span style={{fontSize: '0.7em', color: '#777'}}>{proc.name}</span>
                    )}
                  </div>
                  <Focusable 
                    style={{
                        width: '28px', 
                        height: '28px', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        background: 'rgba(255,255,255,0.1)',
                        borderRadius: '4px',
                        fontSize: '1em',
                        flexShrink: 0
                    }} 
                    onClick={() => addApp(proc.name)}
                  >
                    ＋
                  </Focusable>
                </div>
              </PanelSectionRow>
            ))
          }
        </Focusable>
      </PanelSection>
    </React.Fragment>
  );
};


export default definePlugin((serverApi: ServerAPI) => {
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

  let interval = setInterval(async () => {
    let data = await getEvent();
    if(!data.success) return;
    let event = data.result;
    for (let e of event) {
      if (e.type == 'Inhibit') {
        notify(t("ScreenSaver"), t("Inhibit"))
        clearSuspendTimeout()
        await updateSetting(0, 0, 0, 0);
      } else if (e.type == 'UnInhibit') {
        notify(t("ScreenSaver"), t("UnInhibit"))
        await updateSetting(300, 300, 600, 600);
        // 1. there is no operation for a long period of time (like 15 minutes)
        // 2. the application automatically uninhibit screensaver
        // 3. there is no operation after uninhibit screensaver
        // When these three things happen in sequence, the system will continue to not suspend, even if the time we set has already been reached.
        // In this case, we use a custom timer to suspend system as the workaround.
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
    }
  }, 1000)

  setTimeout(async () => {
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

  return {
    title: <div className={staticClasses.Title}>Suspend Manager</div>,
    content: <Content serverApi={serverApi} />,
    icon: <GiNightSleep />,
    onDismount() {
      if (interval) clearInterval(interval);
      if (controllerHandle) controllerHandle.unregister()
      if (suspendHandle) suspendHandle.unregister()
      setTimeout(async () => {
        await updateSetting(300, 300, 600, 600);
      }, 0);
    },
  };
});
