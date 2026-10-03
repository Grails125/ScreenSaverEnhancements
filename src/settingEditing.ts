export const createSettingEditor = <T,>(
  initial: T,
  persist: (value: T, previous: T) => Promise<boolean>,
  onChange?: (value: T) => void,
) => {
  let confirmed = initial;
  let externalRevision = 0;
  let inFlightWrites = 0;
  let queue = Promise.resolve();
  const pending: Array<{ update: (value: T) => T; revision: number }> = [];
  const listeners = new Set<(value: T) => void>();
  const getValue = () => pending.reduce((value, edit) => edit.update(value), confirmed);
  const publish = () => {
    const value = getValue();
    onChange?.(value);
    listeners.forEach(listener => listener(value));
  };
  const enqueue = <R,>(operation: () => Promise<R>): Promise<R> => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    getValue,
    isPending: () => pending.length > 0 || inFlightWrites > 0,
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      listener(getValue());
      return () => { listeners.delete(listener); };
    },
    edit(update: (value: T) => T): Promise<boolean> {
      const edit = { update, revision: externalRevision };
      pending.push(edit);
      publish();
      return enqueue(async () => {
        // An external close or replacement supersedes edits submitted before it.
        if (edit.revision !== externalRevision) return true;
        let saved = false;
        try {
          const value = update(confirmed);
          inFlightWrites++;
          saved = await persist(value, confirmed) === true;
          if (saved && edit.revision === externalRevision) confirmed = value;
        } catch {
          // A failed operation leaves the last confirmed value in place.
        } finally {
          inFlightWrites = Math.max(0, inFlightWrites - 1);
          const index = pending.indexOf(edit);
          if (index !== -1) pending.splice(index, 1);
          publish();
        }
        return saved;
      });
    },
    synchronize(read: () => Promise<T>): Promise<void> {
      const revision = externalRevision;
      return enqueue(async () => {
        const value = await read();
        if (revision !== externalRevision) return;
        confirmed = value;
        publish();
      });
    },
    acceptExternal(value: T) {
      if (Object.is(value, getValue())) return;
      const revision = ++externalRevision;
      const needsRepair = pending.length > 0 || inFlightWrites > 0;
      pending.length = 0;
      confirmed = value;
      publish();
      // A write already started cannot be cancelled. Save the authoritative
      // external intent after it settles, so it cannot resurrect an old enable.
      if (needsRepair) {
        void enqueue(async () => {
          if (revision !== externalRevision) return;
          inFlightWrites++;
          try { await persist(value, confirmed); } catch { /* The external state stays authoritative. */ }
          finally { inFlightWrites--; }
        });
      }
    },
  };
};

export type SettingEditor<T> = ReturnType<typeof createSettingEditor<T>>;
