import { normalizePowerSettings, PowerSettings } from './powerSettings';

type Dependencies = {
  persist: (settings: PowerSettings) => Promise<boolean>;
  apply: (settings: PowerSettings) => Promise<void>;
  onChange?: (settings: PowerSettings) => void;
  onConfirmed?: (settings: PowerSettings) => void;
  ready?: Promise<PowerSettings | null>;
};
type Edit = { field: keyof PowerSettings; value: unknown };

export const createPowerEditor = (initial: PowerSettings, dependencies: Dependencies) => {
  let confirmed = normalizePowerSettings(initial);
  let queue: Promise<void>;
  let active = true;
  let revision = 0;
  let recoveryNeeded = false;
  let persistenceNeeded = false;
  let synchronizing = false;
  let baselineReady = dependencies.ready === undefined;
  const pending: Edit[] = [];
  const listeners = new Set<(settings: PowerSettings) => void>();
  const getSettings = (): PowerSettings => ({ ...pending.reduce((settings, edit) => normalizePowerSettings({
      ...settings, [edit.field]: edit.value,
    }), confirmed) });
  const publish = () => {
    if (active) {
      dependencies.onChange?.(getSettings());
      listeners.forEach(listener => listener(getSettings()));
    }
  };
  queue = dependencies.ready ? dependencies.ready.then(settings => {
    if (settings) {
      confirmed = normalizePowerSettings(settings);
      baselineReady = true;
      dependencies.onConfirmed?.({ ...confirmed });
      publish();
    }
  }, () => { baselineReady = false; }) : Promise.resolve();
  const persist = async (settings: PowerSettings) => {
    if (!await dependencies.persist({ ...settings })) throw new Error('Power settings save failed');
  };
  const restore = async () => {
    // Attempt both sides even if one fails; future edits must retry an incomplete recovery.
    const failures: unknown[] = [];
    try { await persist(confirmed); } catch (error) { failures.push(error); }
    try { await dependencies.apply({ ...confirmed }); } catch (error) { failures.push(error); }
    recoveryNeeded = failures.length > 0;
    if (recoveryNeeded) throw new Error('Power settings rollback failed; recovery must complete before editing');
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    getSettings,
    get isReady() { return baselineReady; },
    subscribe(listener: (settings: PowerSettings) => void) {
      if (!active) return () => {};
      listeners.add(listener);
      listener(getSettings());
      return () => { listeners.delete(listener); };
    },
    get isPending() { return pending.length > 0; },
    replaceConfirmed(settings: PowerSettings) {
      if (!active || pending.length > 0 || recoveryNeeded || persistenceNeeded || synchronizing) return false;
      revision++;
      confirmed = normalizePowerSettings(settings);
      baselineReady = true;
      dependencies.onConfirmed?.({ ...confirmed });
      publish();
      return true;
    },
    edit(field: keyof PowerSettings, value: unknown): Promise<void> {
      if (!active) return Promise.reject(new Error('Power editor is inactive'));
      const edit = { field, value };
      revision++;
      pending.push(edit);
      publish();
      return enqueue(async () => {
        try {
          if (!active) throw new Error('Power editor is inactive');
          if (!baselineReady) throw new Error('Power profile has not been loaded');
          // A passive read already established the real native baseline. Retry
          // saving it without restoring the older profile it replaced.
          if (persistenceNeeded) {
            await persist(confirmed);
            persistenceNeeded = false;
          }
          if (recoveryNeeded) await restore();
          const candidate = normalizePowerSettings({ ...confirmed, [field]: value });
          try {
            await persist(candidate);
            await dependencies.apply({ ...candidate });
          } catch (error) {
            await restore();
            throw error;
          }
          confirmed = candidate;
          baselineReady = true;
          dependencies.onConfirmed?.({ ...confirmed });
        } finally {
          pending.splice(pending.indexOf(edit), 1);
          publish();
        }
      });
    },
    synchronize(read: () => Promise<PowerSettings | null>): Promise<boolean> {
      if (!active || pending.length > 0 || recoveryNeeded) return Promise.resolve(false);
      const token = revision;
      return enqueue(async () => {
        if (!active || token !== revision || pending.length > 0 || recoveryNeeded) return false;
        synchronizing = true;
        try {
          const settings = await read();
          if (!settings || !active || token !== revision || pending.length > 0) return false;
          const candidate = normalizePowerSettings(settings);
          try {
            await persist(candidate);
            persistenceNeeded = false;
          } catch (error) {
            confirmed = candidate;
            baselineReady = true;
            persistenceNeeded = true;
            dependencies.onConfirmed?.({ ...confirmed });
            publish();
            throw error;
          }
          confirmed = candidate;
          baselineReady = true;
          dependencies.onConfirmed?.({ ...confirmed });
          publish();
          return true;
        } finally {
          synchronizing = false;
        }
      });
    },
    dispose(): Promise<void> {
      active = false;
      listeners.clear();
      revision++;
      // An operation already writing must finish; queued edits are rejected before writing.
      return queue;
    },
  };
};

export type PowerEditor = ReturnType<typeof createPowerEditor>;
