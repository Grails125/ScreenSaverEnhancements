// A hot-reloaded bundle gets new module state, but shares this host with its predecessor.
const cleanupKey = Symbol.for('ScreenSaverEnhancements.powerCleanup');
const powerWriteKey = Symbol.for('ScreenSaverEnhancements.lastPowerWrite');
type PowerSettings = import('./powerSettings').PowerSettings;
type PowerWrite = { settings: PowerSettings; at: number };
type Host = { [cleanupKey]?: Promise<void>; [powerWriteKey]?: PowerWrite };

export const withPowerTimeout = <T>(request: Promise<T>, operation: string, timeoutMs = 5000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs);
    void request.then(resolve, reject).finally(() => clearTimeout(timer));
  });

export const createPowerLifecycle = (host: object) => {
  const shared = host as Host;
  const ready = shared[cleanupKey] ?? Promise.resolve();
  return {
    ready,
    recordPowerWrite(settings: PowerSettings) {
      shared[powerWriteKey] = { settings: { ...settings }, at: Date.now() };
    },
    getLastPowerWrite() {
      return shared[powerWriteKey] ?? null;
    },
    clearPowerWrite(expected: PowerWrite) {
      if (shared[powerWriteKey] === expected) delete shared[powerWriteKey];
    },
    trackCleanup(cleanup: Promise<unknown>) {
      // Failed cleanup leaves its persisted snapshot for the replacement to recover.
      shared[cleanupKey] = Promise.all([ready, cleanup.catch(() => undefined)]).then(() => undefined);
    },
  };
};

const nativePowerKey = Symbol.for('ScreenSaverEnhancements.nativePowerIntent');
type NativeIntent = { settings: PowerSettings; run: (repair?: boolean) => Promise<void> };
type NativeHost = {
  [nativePowerKey]?: { intent: NativeIntent | null; repair: Promise<void> | null; repairNeeded: boolean;
    onError?: (error: unknown) => void | Promise<void> };
};

// Native calls cannot be cancelled. A timed-out stage must never send its next
// stage; if it later acknowledges an applied write, restore the newest complete
// intent, including when that intent belongs to a replacement bundle.
export const createNativePowerWriter = (host: object, options: {
  timeoutMs?: number;
  onComplete?: (settings: PowerSettings) => void;
  onError?: (error: unknown) => void | Promise<void>;
} = {}) => {
  const shared = host as NativeHost;
  const registry = shared[nativePowerKey] ??= { intent: null, repair: null, repairNeeded: false };
  // Replacement factories take over recovery even when startup performs no
  // native write. Their handler waits for their real profile before saving it.
  registry.onError = options.onError;
  const requestRepair = () => {
    registry.repairNeeded = true;
    if (registry.repair) return;
    registry.repair = Promise.resolve().then(async () => {
      registry.repairNeeded = false;
      await registry.intent?.run(true);
    }).catch(error => registry.onError?.(error)).catch(() => undefined).finally(() => {
      registry.repair = null;
      if (registry.repairNeeded) requestRepair();
    });
  };
  const stage = (intent: NativeIntent, write: () => Promise<void>, name: string, repair: boolean) => {
    if (registry.intent !== intent) return Promise.reject(new Error('Native power write was superseded'));
    return new Promise<void>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error(`${name} timed out`));
      }, options.timeoutMs ?? 5000);
      let request: Promise<void>;
      try { request = Promise.resolve(write()); }
      catch (error) { clearTimeout(timer); reject(error); return; }
      void request.then(() => {
        clearTimeout(timer);
        // A repair's own late reply cannot regenerate the same repair forever.
        // Its failure has already preserved recovery state; only a truly newer
        // intent needs another compensation after this obsolete write applies.
        if (registry.intent !== intent || (expired && !repair)) requestRepair();
        if (!expired) {
          if (registry.intent === intent) resolve();
          else reject(new Error('Native power write was superseded'));
        }
      }, error => {
        clearTimeout(timer);
        // A transport rejection is not proof that the native write was never
        // applied. Obsolete failures require the same compensation as replies.
        if (registry.intent !== intent || (expired && !repair)) requestRepair();
        if (!expired) reject(error);
      });
    });
  };
  return {
    write(settings: PowerSettings, writeIdle: (settings: PowerSettings) => Promise<void>,
      writeSuspend: (settings: PowerSettings) => Promise<void>) {
      const intent: NativeIntent = { settings: { ...settings }, run: async (repair = false) => {
        await stage(intent, () => writeIdle({ ...intent.settings }), 'Write native idle settings', repair);
        await stage(intent, () => writeSuspend({ ...intent.settings }), 'Write native suspend settings', repair);
        if (registry.intent === intent) options.onComplete?.({ ...intent.settings });
      } };
      registry.intent = intent;
      return intent.run();
    },
  };
};
