import { findModuleExport } from "@decky/ui";

export type SleepManagerModule = {
  RegisterForNotifyResumeFromSuspend?: (handler: () => void) => unknown;
  NotifyResumeFromSuspend?: (...args: any[]) => unknown;
};

const isSleepManagerModule = (value: any): value is SleepManagerModule => {
  if (typeof value !== "object" || value === null) return false;

  return (
    typeof value.RegisterForNotifyResumeFromSuspend === "function" ||
    typeof value.NotifyResumeFromSuspend === "function"
  );
};

export const getSleepManagerModule = (): SleepManagerModule | null => {
  const globalModule = (window as any)?.SleepManager;
  if (isSleepManagerModule(globalModule)) return globalModule;

  const foundModule = findModuleExport(isSleepManagerModule);

  return isSleepManagerModule(foundModule) ? foundModule : null;
};
