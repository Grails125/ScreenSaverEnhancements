import { DialogButton, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { FC, useEffect, useId, useState } from "react";
import i18n from "./i18n";
import { StateNumber } from "./state";

export const DisplayOffSection: FC<{
  onActivate: () => Promise<void>;
  state: StateNumber;
}> = ({ onActivate, state }) => {
  const [mode, setMode] = useState(state.GetState());
  const t = i18n.useTranslations(i18n.getCurrentLanguage());
  const descriptionId = useId();

  useEffect(() => {
    state.onStateChanged(setMode);
    setMode(state.GetState());
    return () => state.offStateChanged(setMode);
  }, [state]);

  const label = mode === 1 ? t("Turning Screen Off") :
    mode === 3 ? t("Waking Screen") : t("Turn Screen Off");

  return (
    <PanelSection title={t("Screen Off Section")}>
      <PanelSectionRow>
        <Field
          childrenLayout="below"
          description={<span id={descriptionId}>{t("Screen Off Description")}</span>}
          disabled={mode !== 0}
        >
          <DialogButton
            {...{ "aria-describedby": descriptionId }}
            disabled={mode !== 0}
            onMouseDown={event => {
              // Pointer focus can scroll this action away before the synthesized
              // touch click. Controller focus and activation still use Steam's UI.
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={onActivate}
          >
            {label}
          </DialogButton>
        </Field>
      </PanelSectionRow>
    </PanelSection>
  );
};
