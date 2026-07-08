import { VFC, useCallback, useEffect, useRef, useState } from "react";
import { ServerAPI } from "decky-frontend-lib";
import { StateNumber } from "./state";
import { useCatchAllGamepad } from "./useCatchAllGamepad";
import { useResumeFromSuspendNotification } from "./useResumeFromSuspendNotification";
import { UIComposition, useUIComposition } from "./uiComposition";
import { clampOpacity, getPluginBooleanSetting, getPluginNumberSetting, setPluginSetting } from "./settingsClient";

export const BLACK_BACKGROUND_ENABLED = "black_background_enabled";
export const BLACK_BACKGROUND_OPACITY = "black_background_opacity";
export const BLACK_BACKGROUND_CLOSE_ON_ANY_KEY = "black_background_close_on_any_key";

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
  const stateChangeTokenRef = useRef(0);
  const { subscribe, release } = useCatchAllGamepad();
  const {
    subscribe: subscribeResumeFromSuspend,
    release: releaseResumeFromSuspend,
  } = useResumeFromSuspendNotification();

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

  const stopResumeCapture = useCallback(() => {
    releaseResumeFromSuspend();
  }, [releaseResumeFromSuspend]);

  const closeOverlay = useCallback(() => {
    stopCapture();
    stopResumeCapture();
    overlayState.SetState(0);
    void setPluginSetting(serverApi, BLACK_BACKGROUND_ENABLED, false);
  }, [overlayState, serverApi, stopCapture, stopResumeCapture]);

  const scheduleAnyKeyClose = useCallback(() => {
    clearDelayedSubscription();
    delayedSubscriptionRef.current = window.setTimeout(() => {
      delayedSubscriptionRef.current = null;
      subscribe(closeOverlay);
    }, 200);
  }, [clearDelayedSubscription, closeOverlay, subscribe]);

  useEffect(() => {
    const onOverlayChanged = async (mode: number) => {
      const token = stateChangeTokenRef.current + 1;
      stateChangeTokenRef.current = token;

      if (mode !== 1) {
        setVisible(false);
        stopCapture();
        stopResumeCapture();
        return;
      }

      const [opacityValue, closeOnAnyKeyValue] = await Promise.all([
        getPluginNumberSetting(serverApi, BLACK_BACKGROUND_OPACITY, opacityState.GetState()),
        getPluginBooleanSetting(serverApi, BLACK_BACKGROUND_CLOSE_ON_ANY_KEY, false),
      ]);
      if (token !== stateChangeTokenRef.current) return;

      const nextOpacity = clampOpacity(opacityValue);
      setOpacity(nextOpacity);
      opacityState.SetState(nextOpacity);
      setVisible(true);

      if (closeOnAnyKeyValue) {
        scheduleAnyKeyClose();
      } else {
        stopCapture();
      }

      subscribeResumeFromSuspend(closeOverlay);
    };

    overlayState.onStateChanged(onOverlayChanged);
    void onOverlayChanged(overlayState.GetState());

    return () => {
      overlayState.offStateChanged(onOverlayChanged);
      stateChangeTokenRef.current += 1;
      stopCapture();
      stopResumeCapture();
    };
  }, [
    overlayState,
    opacityState,
    scheduleAnyKeyClose,
    serverApi,
    stopCapture,
    stopResumeCapture,
    subscribeResumeFromSuspend,
    closeOverlay,
  ]);

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
