import { FC, useEffect, useState } from 'react';
import { StateNumber } from './state';
import { UIComposition, useUIComposition } from './uiComposition';

const InputSurface: FC<{ dark: boolean }> = ({ dark }) => {
  // Keep Steam input focused on its UI while the physical display is off.
  useUIComposition(UIComposition.Overlay);
  return <div style={{ position: 'fixed', inset: 0, background: dark ? '#000' : 'transparent', zIndex: 7003, pointerEvents: dark ? 'auto' : 'none' }} />;
};

export const DisplayOffSurface: FC<{ state: StateNumber }> = ({ state }) => {
  const [mode, setMode] = useState(state.GetState());
  useEffect(() => {
    const changed = (value: number) => setMode(value);
    state.onStateChanged(changed);
    changed(state.GetState());
    return () => state.offStateChanged(changed);
  }, [state]);
  // Recovery may retry power-setting cleanup after the physical screen is on.
  return mode !== 0 ? <InputSurface dark={mode !== 3} /> : null;
};
