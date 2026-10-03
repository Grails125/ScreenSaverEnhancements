import React from 'react';
import { GiNightSleep } from 'react-icons/gi';
import { PluginServerApi } from './deckyApi';
import { isPluginSettingSaveSuccessful, setPluginSetting } from './settingsClient';
import { createSettingEditor, SettingEditor } from './settingEditing';

type Translate = (key: any) => string;
type SettingBinding<T> = {
  publish(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
  shouldAcceptExternal?(value: T): boolean;
};
type EditorEntry = {
  editor: SettingEditor<any>;
  persist?: (value: any, previous: any) => Promise<boolean>;
  binding?: SettingBinding<any>;
  releaseExternal?: () => void;
};
type EditorRegistry = { active: boolean; entries: Map<string, EditorEntry> };
const registries = new WeakMap<PluginServerApi, EditorRegistry>();

export const disposePluginSettings = (serverApi: PluginServerApi) => {
  const registry = registries.get(serverApi);
  if (!registry) return;
  registry.active = false;
  registry.entries.forEach(entry => {
    entry.releaseExternal?.();
    entry.releaseExternal = undefined;
    entry.binding = undefined;
    entry.persist = undefined;
  });
  registries.delete(serverApi);
};

export const usePluginSettings = (serverApi: PluginServerApi, translate: Translate) => {
  let registry = registries.get(serverApi);
  if (!registry) {
    registry = {active: true, entries: new Map()};
    registries.set(serverApi, registry);
  }
  const current = registry;
  const getEditor = <T,>(key: string, initial: T, persist?: (value: T, previous: T) => Promise<boolean>,
    binding?: SettingBinding<T>): SettingEditor<T> => {
    let entry = current.entries.get(key);
    if (!entry) {
      let created: EditorEntry;
      const editor = createSettingEditor(initial, (value, previous) => {
        if (!current.active) return Promise.resolve(false);
        return created.persist ? created.persist(value, previous) : setPluginSetting(serverApi, key, value);
      }, value => { if (current.active) created.binding?.publish(value); });
      created = {editor};
      current.entries.set(key, created);
      entry = created;
    }
    if (persist) entry.persist = persist;
    if (binding) entry.binding = binding;
    if (binding && !entry.releaseExternal) {
      const connected = entry;
      entry.releaseExternal = binding.subscribe(value => {
        if (current.active && connected.binding?.shouldAcceptExternal?.(value) !== false) {
          connected.editor.acceptExternal(value);
        }
      });
    }
    return entry.editor;
  };

  const reportSaveFailure = () => {
    if (!current.active) return;
    serverApi.toaster.toast({
      title: translate('Settings Save Failed'),
      body: translate('Settings Save Failed Body'),
      icon: React.createElement(GiNightSleep),
      critical: true,
      duration: 4000,
    });
  };
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
      reportSaveFailure();
      return false;
    }
  };

  return { saveSetting, getEditor, reportSaveFailure, isActive: () => current.active };
};
