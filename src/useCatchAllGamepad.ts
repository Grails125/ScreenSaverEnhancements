import { useCallback, useRef } from "react";

type ReleaseHandle = (() => void) | null;

type SteamReleaseHandle = {
  unregister?: () => void;
  Unregister?: () => void;
};

const normalizeReleaseHandle = (releaseHandle: unknown): ReleaseHandle => {
  if (typeof releaseHandle === "function") return releaseHandle as () => void;

  if (releaseHandle && typeof releaseHandle === "object") {
    const handle = releaseHandle as SteamReleaseHandle;
    if (typeof handle.Unregister === "function") return () => handle.Unregister?.();
    if (typeof handle.unregister === "function") return () => handle.unregister?.();
  }

  return null;
};

export const useCatchAllGamepad = () => {
  const releaseRef = useRef<ReleaseHandle>(null);
  const navManagerRef = useRef<any>(null);

  const release = useCallback(() => {
    if (!navManagerRef.current) {
      releaseRef.current = null;
      return;
    }

    releaseRef.current?.();

    navManagerRef.current = null;
    releaseRef.current = null;
  }, []);

  const subscribe = useCallback((handler: (navEvent: unknown, rawEvent: unknown) => void) => {
    if (releaseRef.current || navManagerRef.current) return;

    const navManager = (window as any)?.SteamUIStore?.NavigationManager;
    if (!navManager?.SetCatchAllGamepadInput) return;

    navManagerRef.current = navManager;
    releaseRef.current = normalizeReleaseHandle(
      navManager.SetCatchAllGamepadInput(handler),
    );
  }, []);

  return { subscribe, release };
};
