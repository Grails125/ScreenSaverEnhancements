import React from 'react';
import { GiNightSleep } from 'react-icons/gi';
import { PluginServerApi } from './deckyApi';
import { isPluginSettingSaveSuccessful, setPluginSetting } from './settingsClient';

type Translate = (key: any) => string;

export const usePluginSettings = (serverApi: PluginServerApi, translate: Translate) => {
  const saveSetting = async (
    key: string,
    value: unknown,
    rollback: () => void,
  ): Promise<boolean> => {
    try {
      const response = await setPluginSetting(serverApi, key, value);
      if (isPluginSettingSaveSuccessful(response)) return true;
      throw new Error('settings RPC failed');
    } catch {
      rollback();
      serverApi.toaster.toast({
        title: translate('Settings Save Failed'),
        body: translate('Settings Save Failed Body'),
        icon: React.createElement(GiNightSleep),
        critical: true,
        duration: 4000,
      });
      return false;
    }
  };

  return { saveSetting };
};
