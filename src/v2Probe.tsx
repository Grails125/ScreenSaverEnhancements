import { callable, definePlugin, routerHook, toaster } from "@decky/api";
import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { GiNightSleep } from "react-icons/gi";

type Diagnostics = Record<string, unknown>;

const OVERLAY_COMPONENT = "ScreenSaverEnhancementsV2ProbeOverlay";
const getDiagnostics = callable<[], Diagnostics>("get_diagnostics");

let overlayVisible = false;
const overlayListeners = new Set<(visible: boolean) => void>();

const setOverlayVisible = (visible: boolean) => {
  overlayVisible = visible;
  overlayListeners.forEach((listener) => listener(visible));
};

function CompatibilityOverlay() {
  const [visible, setVisible] = useState(overlayVisible);

  useEffect(() => {
    overlayListeners.add(setVisible);
    return () => {
      overlayListeners.delete(setVisible);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      onClick={() => setOverlayVisible(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 7002,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.92)",
        color: "white",
      }}
    >
      V2 global overlay probe — click to close
    </div>
  );
}

function ProbePanel() {
  const [diagnosticsState, setDiagnosticsState] = useState("Not tested");

  const runDiagnostics = async () => {
    try {
      const diagnostics = await getDiagnostics();
      setDiagnosticsState(`${Object.keys(diagnostics).length} fields returned`);
      toaster.toast({
        title: "V2 compatibility probe",
        body: "Modern callable RPC succeeded.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDiagnosticsState(`Failed: ${message}`);
      toaster.toast({
        title: "V2 compatibility probe failed",
        body: message,
        critical: true,
      });
    }
  };

  return (
    <PanelSection title="Decky V2 compatibility">
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => void runDiagnostics()}>
          Test diagnostics RPC
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>{diagnosticsState}</PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOverlayVisible(true)}>
          Test global overlay
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  routerHook.addGlobalComponent(OVERLAY_COMPONENT, CompatibilityOverlay);

  return {
    name: "ScreenSaver Enhancements V2 Probe",
    content: <ProbePanel />,
    icon: <GiNightSleep />,
    onDismount() {
      setOverlayVisible(false);
      overlayListeners.clear();
      routerHook.removeGlobalComponent(OVERLAY_COMPONENT);
    },
  };
});
