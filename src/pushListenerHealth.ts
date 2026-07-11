export type PushListenerHealthSnapshot = {
  pushListenerActive: boolean;
  pushReconnectCount: number;
};

export const createPushListenerHealth = () => {
  let active = false;
  let connectedBefore = false;
  let reconnectCount = 0;

  return {
    markConnected() {
      if (!active && connectedBefore) {
        reconnectCount += 1;
      }
      active = true;
      connectedBefore = true;
    },
    markDisconnected() {
      active = false;
    },
    snapshot(): PushListenerHealthSnapshot {
      return {
        pushListenerActive: active,
        pushReconnectCount: reconnectCount,
      };
    },
  };
};
