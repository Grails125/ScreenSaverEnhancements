import { useCallback, useRef } from "react";
import { getSleepManagerModule } from "./sleepManager";

type ReleaseHandle = (() => void) | null;
type RegisterFunctionInfo = {
  register: ((handler: () => void) => unknown) | null;
  source: string;
};

const buildReleaseHandle = (handle: unknown): ReleaseHandle => {
  if (!handle) return null;
  if (typeof handle === "function") return handle as () => void;

  if (typeof (handle as any).unregister === "function") {
    return () => (handle as any).unregister();
  }

  if (typeof (handle as any).Unregister === "function") {
    return () => (handle as any).Unregister();
  }

  return null;
};

const getRegisterFunction = (): RegisterFunctionInfo => {
  const sleepManagerModule = getSleepManagerModule();
  if (sleepManagerModule?.RegisterForNotifyResumeFromSuspend) {
    return {
      register: sleepManagerModule.RegisterForNotifyResumeFromSuspend,
      source: "SleepManager module",
    };
  }

  const steamClient = (window as any)?.SteamClient;
  if (steamClient?.System?.RegisterForNotifyResumeFromSuspend) {
    return {
      register: steamClient.System.RegisterForNotifyResumeFromSuspend,
      source: "SteamClient.System",
    };
  }

  if (steamClient?.System?.SleepManager?.RegisterForNotifyResumeFromSuspend) {
    return {
      register: steamClient.System.SleepManager.RegisterForNotifyResumeFromSuspend,
      source: "SteamClient.System.SleepManager",
    };
  }

  return { register: null, source: "missing" };
};

export const useResumeFromSuspendNotification = () => {
  const releaseRef = useRef<ReleaseHandle>(null);

  const release = useCallback(() => {
    if (!releaseRef.current) return;
    releaseRef.current();
    releaseRef.current = null;
  }, []);

  const subscribe = useCallback((handler: () => void) => {
    if (releaseRef.current) return;

    const { register, source } = getRegisterFunction();
    if (typeof register !== "function") {
      console.warn("[ScreenSaverEnhancements] Resume from suspend notification API was not found");
      return;
    }

    const releaseHandle = buildReleaseHandle(register(handler));
    releaseRef.current = releaseHandle ?? (() => undefined);
    console.info(`[ScreenSaverEnhancements] Registered resume listener via ${source}`);
    if (!releaseHandle) {
      console.warn("[ScreenSaverEnhancements] Resume listener registered without a release handle");
    }
  }, []);

  return { subscribe, release };
};
