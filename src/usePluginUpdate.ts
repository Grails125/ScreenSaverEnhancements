import React, { useRef, useState } from 'react';
import { GiNightSleep } from 'react-icons/gi';
import { PluginServerApi } from './deckyApi';

const UPDATE_INSTALL_POLL_INTERVAL_MS = 1000;
const UPDATE_INSTALL_MAX_POLLS = 120;

type Translate = (key: any) => string;

export const usePluginUpdate = (
  serverApi: PluginServerApi,
  getRequestToken: () => number,
  isCurrentRequest: (token: number) => boolean,
  translate: Translate,
) => {
  const [pluginVersion, setPluginVersion] = useState<string>('');
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [updateNotes, setUpdateNotes] = useState<string>('');
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
  const [checkingUpdate, setCheckingUpdate] = useState<boolean>(false);
  const [installingUpdate, setInstallingUpdate] = useState<boolean>(false);
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState<string>('');
  const [updateSha256, setUpdateSha256] = useState<string>('');
  const updateCheckInFlight = useRef(false);

  const loadPluginVersion = async (token: number) => {
    try {
      const version = await serverApi.getPluginVersion();
      if (isCurrentRequest(token)) setPluginVersion(version);
    } catch (error) {
      console.warn('[ScreenSaverEnhancements] Could not load plugin version', error);
    }
  };

  const checkUpdate = async () => {
    if (updateCheckInFlight.current) return;
    updateCheckInFlight.current = true;
    setCheckingUpdate(true);
    const token = getRequestToken();
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
        title: translate(result.has_update ? 'Update Available' : 'No Update'),
        body: result.has_update
          ? `${result.current} -> ${result.latest}`
          : translate('Already Latest Version'),
        icon: React.createElement(GiNightSleep),
        critical: result.has_update,
        duration: result.has_update ? 5000 : 3000,
      });
    } catch (error) {
      console.warn('[ScreenSaverEnhancements] Update check failed', error);
      if (!isCurrentRequest(token)) return;
      setUpdateAvailable(false);
      setUpdateNotes('');
      setUpdateDownloadUrl('');
      setUpdateSha256('');
      serverApi.toaster.toast({
        title: translate('Update Check Failed'),
        body: translate('Update Check Failed'),
        icon: React.createElement(GiNightSleep),
        critical: true,
        duration: 4000,
      });
    } finally {
      updateCheckInFlight.current = false;
      if (isCurrentRequest(token)) setCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    if (installingUpdate || !updateAvailable || !updateDownloadUrl || !updateSha256) return;
    setInstallingUpdate(true);
    try {
      await serverApi.installPluginUpdate({
        downloadUrl: updateDownloadUrl,
        version: latestVersion,
        sha256: updateSha256,
      });
      for (let attempt = 0; attempt < UPDATE_INSTALL_MAX_POLLS; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, UPDATE_INSTALL_POLL_INTERVAL_MS));
        const installedVersion = await serverApi.getInstalledPluginVersion();
        if (installedVersion === latestVersion) {
          await serverApi.restartDecky();
          return;
        }
      }
      throw new Error('Decky installer did not finish before the timeout');
    } catch (error) {
      console.error('[ScreenSaverEnhancements] Update installation failed', error);
      serverApi.toaster.toast({
        title: translate('Update Install Failed'),
        body: translate('Update Install Failed'),
        icon: React.createElement(GiNightSleep),
        critical: true,
        duration: 4000,
      });
    } finally {
      setInstallingUpdate(false);
    }
  };

  return {
    pluginVersion,
    latestVersion,
    updateNotes,
    updateAvailable,
    checkingUpdate,
    installingUpdate,
    updateDownloadUrl,
    updateSha256,
    loadPluginVersion,
    checkUpdate,
    installUpdate,
  };
};
