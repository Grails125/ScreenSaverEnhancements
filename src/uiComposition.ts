import { findModuleChild } from "@decky/ui";

export enum UIComposition {
  Hidden = 0,
  Notification = 1,
  Overlay = 2,
  Opaque = 3,
  OverlayKeyboard = 4,
  OverlayQAM = 5,
  OverlayKeyboard1 = 6,
}

export const useUIComposition: (composition: UIComposition) => void = findModuleChild(
  (m) => {
    if (typeof m !== "object") return undefined;

    for (const prop in m) {
      if (
        typeof m[prop] === "function" &&
        m[prop].toString().includes("AddMinimumCompositionStateRequest") &&
        m[prop].toString().includes("ChangeMinimumCompositionStateRequest") &&
        m[prop].toString().includes("RemoveMinimumCompositionStateRequest") &&
        !m[prop].toString().includes("m_mapCompositionStateRequests")
      ) {
        return m[prop];
      }
    }

    return undefined;
  }
);
