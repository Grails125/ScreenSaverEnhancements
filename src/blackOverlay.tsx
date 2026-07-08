import { VFC, useCallback, useEffect, useRef, useState } from "react";
import { ServerAPI } from "decky-frontend-lib";
import { StateNumber } from "./state";
import { useCatchAllGamepad } from "./useCatchAllGamepad";
import { UIComposition, useUIComposition } from "./uiComposition";

export const BLACK_BACKGROUND_ENABLED = "black_background_enabled";
export const BLACK_BACKGROUND_OPACITY = "black_background_opacity";
export const BLACK_BACKGROUND_CLOSE_ON_ANY_KEY = "black_background_close_on_any_key";

const clampOpacity = (value: number): number => {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
};

const loadSetting = async <T,>(serverApi: ServerAPI, key: string, defaults: T): Promise<T> => {
  const response = await serverApi.callPluginMethod<any, any>("get_settings", { key, defaults });
  return response.success ? response.result : defaults;
};

const saveSetting = async (serverApi: ServerAPI, key: string, value: any) => {
  await serverApi.callPluginMethod<any, any>("set_settings", { key, value });
};

const BlackBackground: VFC<{ opacity: number }> = ({ opacity }) => {
  useUIComposition(UIComposition.Overlay);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "#000",
        opacity,
        zIndex: 7002,
        pointerEvents: "auto",
      }}
    />
  );
};

export const BlackOverlay: VFC<{
  serverApi: ServerAPI;
  overlayState: StateNumber;
  opacityState: StateNumber;
}> = ({ serverApi, overlayState, opacityState }) => {
  const [visible, setVisible] = useState<boolean>(overlayState.GetState() === 1);
  const [opacity, setOpacity] = useState<number>(opacityState.GetState());
  const delayedSubscriptionRef = useRef<number | null>(null);
  const { subscribe, release } = useCatchAllGamepad();

  const clearDelayedSubscription = useCallback(() => {
    if (delayedSubscriptionRef.current !== null) {
      window.clearTimeout(delayedSubscriptionRef.current);
      delayedSubscriptionRef.current = null;
    }
  }, []);

  const stopCapture = useCallback(() => {
    clearDelayedSubscription();
    release();
  }, [clearDelayedSubscription, release]);

  const closeOverlay = useCallback(() => {
    stopCapture();
    overlayState.SetState(0);
    void saveSetting(serverApi, BLACK_BACKGROUND_ENABLED, false);
  }, [overlayState, serverApi, stopCapture]);

  const scheduleAnyKeyClose = useCallback(() => {
    clearDelayedSubscription();
    delayedSubscriptionRef.current = window.setTimeout(() => {
      delayedSubscriptionRef.current = null;
      subscribe(closeOverlay);
    }, 200);
  }, [clearDelayedSubscription, closeOverlay, subscribe]);

  useEffect(() => {
    const onOverlayChanged = async (mode: number) => {
      if (mode !== 1) {
        setVisible(false);
        stopCapture();
        return;
      }

      const [opacityValue, closeOnAnyKeyValue] = await Promise.all([
        loadSetting(serverApi, BLACK_BACKGROUND_OPACITY, opacityState.GetState()),
        loadSetting(serverApi, BLACK_BACKGROUND_CLOSE_ON_ANY_KEY, false),
      ]);
      const nextOpacity = clampOpacity(Number(opacityValue));
      setOpacity(nextOpacity);
      opacityState.SetState(nextOpacity);
      setVisible(true);

      if (parseBoolean(closeOnAnyKeyValue, false)) {
        scheduleAnyKeyClose();
      } else {
        stopCapture();
      }
    };

    overlayState.onStateChanged(onOverlayChanged);
    void onOverlayChanged(overlayState.GetState());

    return () => {
      overlayState.offStateChanged(onOverlayChanged);
      stopCapture();
    };
  }, [overlayState, opacityState, scheduleAnyKeyClose, serverApi, stopCapture]);

  useEffect(() => {
    const onOpacityChanged = (value: number) => {
      setOpacity(clampOpacity(value));
    };

    opacityState.onStateChanged(onOpacityChanged);
    return () => opacityState.offStateChanged(onOpacityChanged);
  }, [opacityState]);

  if (!visible) return null;

  return <BlackBackground opacity={opacity} />;
};
