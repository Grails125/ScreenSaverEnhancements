import { findModuleExport } from "@decky/ui";

export enum UIComposition {
  Hidden = 0,
  Notification = 1,
  Overlay = 2,
  Opaque = 3,
  OverlayKeyboard = 4,
  OverlayQAM = 5,
  OverlayKeyboard1 = 6,
}

export const useUIComposition: (composition: UIComposition) => void = findModuleExport(
  (candidate) =>
    typeof candidate === "function" &&
    candidate.toString().includes("AddMinimumCompositionStateRequest") &&
    candidate.toString().includes("ChangeMinimumCompositionStateRequest") &&
    candidate.toString().includes("RemoveMinimumCompositionStateRequest") &&
    !candidate.toString().includes("m_mapCompositionStateRequests"),
);
