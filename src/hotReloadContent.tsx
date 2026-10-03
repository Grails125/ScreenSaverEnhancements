import React, { ReactNode, useEffect, useState } from 'react';

type Snapshot = { revision: number; content: ReactNode };
type Registry = {
  owner: symbol | null;
  snapshot: Snapshot;
  listeners: Set<(snapshot: Snapshot) => void>;
};
const registryKey = Symbol.for('ScreenSaverEnhancements.hotReloadContent');

// Decky can retain activePlugin.content after replacing its plugin list. A retained
// wrapper follows this shared registry instead of retaining disposed runtime props.
export const createHotReloadContentRegistry = (host: object) => {
  const shared = host as Record<PropertyKey, unknown>;
  let registry = shared[registryKey] as Registry | undefined;
  if (!registry) {
    registry = { owner: null, snapshot: { revision: 0, content: null }, listeners: new Set() };
    shared[registryKey] = registry;
  }
  const current = registry;
  const publish = (content: ReactNode) => {
    current.snapshot = { revision: current.snapshot.revision + 1, content };
    current.listeners.forEach(listener => listener(current.snapshot));
  };
  return {
    getSnapshot: () => current.snapshot,
    subscribe(listener: (snapshot: Snapshot) => void) {
      current.listeners.add(listener);
      listener(current.snapshot);
      return () => { current.listeners.delete(listener); };
    },
    register(content: ReactNode) {
      const owner = Symbol('content owner');
      current.owner = owner;
      publish(content);
      return () => {
        if (current.owner !== owner) return;
        current.owner = null;
        publish(null);
      };
    },
  };
};

export const createHotReloadContent = (host: object, content: ReactNode) => {
  const registry = createHotReloadContentRegistry(host);
  const retire = registry.register(content);
  const HotReloadContent = () => {
    const [snapshot, setSnapshot] = useState(registry.getSnapshot);
    useEffect(() => registry.subscribe(setSnapshot), []);
    return <React.Fragment key={snapshot.revision}>{snapshot.content}</React.Fragment>;
  };
  return { content: <HotReloadContent />, retire };
};
