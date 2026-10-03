import { findModuleExport } from "@decky/ui";

type RPCResponse = {
  BSuccess(): boolean;
  GetEResult(): number;
  Body(): { toObject(): unknown };
};
type GamescopeService = {
  SetDisplayPowerStateHandler: { name: string };
  GetState(request: Record<string, never>): Promise<unknown>;
  SetDisplayPowerState(request: { estate: number }): Promise<unknown>;
};
export type DisplayPower = { supported: boolean; isOn: boolean; isInternal: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGamescopeService = (value: unknown): value is GamescopeService =>
  isRecord(value) &&
  isRecord(value.SetDisplayPowerStateHandler) &&
  value.SetDisplayPowerStateHandler.name === "Gamescope.SetDisplayPowerState#1" &&
  typeof value.GetState === "function" &&
  typeof value.SetDisplayPowerState === "function";

let cachedService: GamescopeService | null = null;
const invalidateService = (service: GamescopeService | null) => {
  // An older pending request must not invalidate a service discovered meanwhile.
  if (cachedService === service) cachedService = null;
};
const getService = (): GamescopeService | null => {
  if (isGamescopeService(cachedService)) return cachedService;
  cachedService = null;
  const service: unknown = findModuleExport(isGamescopeService);
  if (isGamescopeService(service)) cachedService = service;
  return cachedService;
};

const requireSuccess = (response: unknown, operation: string): RPCResponse => {
  if (!isRecord(response) || typeof response.BSuccess !== "function" ||
      typeof response.GetEResult !== "function" || typeof response.Body !== "function") {
    throw new Error(`${operation}: invalid Gamescope response`);
  }
  const rpc = response as unknown as RPCResponse;
  if (rpc.BSuccess() !== true) {
    throw new Error(`${operation}: Gamescope result ${rpc.GetEResult()}`);
  }
  return rpc;
};

const RPC_TIMEOUT_MS = 5000;

type DisplayIntent = { revision: number; on: boolean; pendingWakeRequests: number };
// Decky reloads leave outstanding promises from the old module alive. Keep the
// latest intent on the shared UI global so their recovery observes the new owner.
const INTENT_KEY = Symbol.for('ScreenSaverEnhancements.displayPowerIntent');
const getIntent = (): DisplayIntent => {
  const shared = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = shared[INTENT_KEY];
  if (isRecord(existing) && typeof existing.revision === 'number' && typeof existing.on === 'boolean') {
    if (typeof existing.pendingWakeRequests !== 'number') existing.pendingWakeRequests = 0;
    return existing as DisplayIntent;
  }
  const intent = { revision: 0, on: true, pendingWakeRequests: 0 };
  shared[INTENT_KEY] = intent;
  return intent;
};

const reserveWakeRequest = (): (() => void) => {
  const intent = getIntent();
  intent.pendingWakeRequests++;
  let owned = true;
  return () => {
    if (!owned) return;
    owned = false;
    intent.pendingWakeRequests--;
  };
};

const boundedRPC = (
  request: Promise<unknown>,
  operation: string,
  onLateSettlement?: () => Promise<unknown>,
): Promise<unknown> => new Promise((resolve, reject) => {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    reject(new Error(`${operation}: Gamescope RPC timed out`));
  }, RPC_TIMEOUT_MS);
  const restoreLateRequest = () => {
    if (onLateSettlement) {
      // The caller has already cleaned up. A delayed Off still needs a following On.
      void Promise.resolve().then(onLateSettlement).catch(() => undefined);
    }
  };
  request.then(value => {
    clearTimeout(timer);
    if (expired) restoreLateRequest();
    else resolve(value);
  }, error => {
    clearTimeout(timer);
    // A transport failure does not prove that the display mutation was never applied.
    if (expired) restoreLateRequest();
    else reject(error);
  });
});

// Steam private RPCs can change between client versions. Unknown contracts fail closed.
const readDisplayPower = async (service: GamescopeService): Promise<DisplayPower> => {
  try {
    const response = requireSuccess(await boundedRPC(service.GetState({}), "Get display power"), "Get display power");
    const body = response.Body().toObject();
    const state = isRecord(body) && isRecord(body.state) ? body.state : null;
    const display = state && isRecord(state.active_display_info) ? state.active_display_info : null;
    const power = display?.display_state;
    const status = {
      supported: state?.is_service_available === true &&
        state?.is_display_state_management_supported === true && (power === 1 || power === 2),
      isOn: power === 2,
      // Only Steam's explicit internal-display flag permits this plugin to switch power.
      isInternal: display?.is_external === false,
    };
    if (!status.supported) invalidateService(service);
    return status;
  } catch (error) {
    invalidateService(service);
    throw error;
  }
};

export const getDisplayPower = async (): Promise<DisplayPower> => {
  const service = getService();
  return service ? readDisplayPower(service) : { supported: false, isOn: false, isInternal: false };
};

export const setDisplayPower = async (on: boolean): Promise<void> => {
  const intent = getIntent();
  // Timing out a wake RPC does not cancel the underlying mutation. Do not
  // accept a new Off that an outstanding On could undo, including after reload.
  if (!on && intent.pendingWakeRequests > 0) throw new Error('Display wake request is still pending');
  const revision = ++intent.revision;
  intent.on = on;
  let mutationPending = false;
  const releaseWake = on ? reserveWakeRequest() : () => {};
  let service: GamescopeService | null = null;
  try {
    service = getService();
    if (!service) throw new Error("Gamescope display power service unavailable");
    const current = await readDisplayPower(service);
    if (!current.supported || !current.isInternal) {
      throw new Error("Internal display power management unavailable");
    }
    if (intent.revision !== revision) throw new Error('Display power request was superseded');
    const confirmedService = service;
    // EDisplayPowerState: Off = 1, On = 2; distinct from SleepManager download mode.
    const restoreLateOff = async () => {
      // A newer session may intentionally own an off panel. Its intent wins even
      // when this callback belongs to an older, already unloaded module.
      if (!getIntent().on) return;
      // A fresh capability read can fail while the confirmed internal panel is off.
      const releaseRecoveryWake = reserveWakeRequest();
      let recoveryPending = false;
      try {
        const request = confirmedService.SetDisplayPowerState({ estate: 2 });
        recoveryPending = true;
        void request.then(releaseRecoveryWake, releaseRecoveryWake);
        requireSuccess(await boundedRPC(request, "Restore display power"), "Restore display power");
      } catch (error) {
        invalidateService(confirmedService);
        throw error;
      } finally {
        if (!recoveryPending) releaseRecoveryWake();
      }
    };
    const request = service.SetDisplayPowerState({ estate: on ? 2 : 1 });
    if (on) {
      mutationPending = true;
      void request.then(releaseWake, releaseWake);
    }
    requireSuccess(await boundedRPC(
      request,
      "Set display power",
      on ? undefined : restoreLateOff,
    ), "Set display power");
  } catch (error) {
    invalidateService(service);
    // A failed Off no longer owns an off intent; an older delayed Off must still
    // be restored. Never overwrite a request that superseded this one meanwhile.
    if (!on && intent.revision === revision) intent.on = true;
    throw error;
  } finally {
    if (!mutationPending) releaseWake();
  }
};
