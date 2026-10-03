type RuntimeSyncOptions = {
  enqueue: (operation: () => Promise<void>) => Promise<void>;
  synchronize: (showStateNotification: boolean) => Promise<void>;
  isActive: () => boolean;
  onError: (error: unknown, canRecover: boolean) => void;
};

// Keep one queued/in-flight sync and one dirty flag. Follow-ups join the end of
// the power queue so a stream of events cannot starve user power operations.
export const createRuntimeSyncScheduler = (options: RuntimeSyncOptions) => {
  let scheduled = false;
  let dirty = false;
  let notify = false;
  let recoveryRequested = false;
  let cancelled = false;

  const request = (showStateNotification = false, recoverOnFailure = true) => {
    if (cancelled || !options.isActive()) return;
    dirty = true;
    notify ||= showStateNotification;
    recoveryRequested ||= recoverOnFailure;
    if (scheduled) return;
    scheduled = true;
    let canRecover = false;
    let showNotification = false;
    void options.enqueue(async () => {
      if (cancelled || !options.isActive()) return;
      showNotification = notify;
      canRecover = recoveryRequested;
      dirty = false;
      notify = false;
      recoveryRequested = false;
      await options.synchronize(showNotification);
    }).then(() => {
      scheduled = false;
      if (dirty) request(false, false);
    }, error => {
      scheduled = false;
      // Reconnection schedules its own retry. Preserve pending notification
      // intent, but do not create an automatic tight loop on backend failures.
      if (!cancelled && options.isActive()) {
        notify ||= showNotification;
        options.onError(error, canRecover);
      }
    });
  };

  return {request, cancel: () => {cancelled = true; dirty = false; notify = false; recoveryRequested = false;}};
};
