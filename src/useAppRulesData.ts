import { useState } from 'react';
import { InhibitStatus, PluginServerApi, RunningProcess } from './deckyApi';
import { normalizeManualApps } from './settingsClient';

export const EMPTY_INHIBIT_STATUS: InhibitStatus = {
  manual_apps: [],
  manual_active_app: null,
  manual_active: false,
  dbus_requests: [],
  dbus_active: false,
  is_inhibiting: false,
};

export const useAppRulesData = (
  serverApi: PluginServerApi,
  isPanelVisible: () => boolean,
  isCurrentRequest: (token: number) => boolean,
  getRequestToken: () => number,
) => {
  const [inhibitStatus, setInhibitStatus] = useState<InhibitStatus>(EMPTY_INHIBIT_STATUS);
  const [runningProcesses, setRunningProcesses] = useState<RunningProcess[]>([]);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const fetchRunningProcesses = async () => {
    if (!isPanelVisible()) return;
    const token = getRequestToken();
    setRefreshing(true);
    try {
      const processes = await serverApi.getRunningProcesses();
      if (isCurrentRequest(token)) {
        setRunningProcesses(processes);
      }
    } catch (error) {
      console.warn('[ScreenSaverEnhancements] Could not load running processes', error);
    } finally {
      if (isCurrentRequest(token)) {
        setRefreshing(false);
      }
    }
  };

  const fetchInhibitStatus = async () => {
    if (!isPanelVisible()) return;
    const token = getRequestToken();
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
      console.warn('[ScreenSaverEnhancements] Could not load inhibit status', error);
    }
  };

  const refreshInhibitStatus = async () => {
    await fetchInhibitStatus();
  };

  const refreshAppMenuData = async () => {
    await Promise.all([fetchRunningProcesses(), fetchInhibitStatus()]);
  };

  return {
    inhibitStatus,
    runningProcesses,
    refreshing,
    fetchInhibitStatus,
    refreshInhibitStatus,
    refreshAppMenuData,
  };
};
