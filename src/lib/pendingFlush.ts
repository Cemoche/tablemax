/**
 * Pending-input flushers: components that debounce their input before it reaches a
 * store (the SQL editor) register a function here so the window close can push what is
 * still pending into the store before the session is saved.
 */
const flushers = new Set<() => void>();

/** Registers `fn`; returns the function that unregisters it. */
export function registerPendingFlush(fn: () => void): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

export function flushPending(): void {
  for (const fn of [...flushers]) {
    try {
      fn();
    } catch {
      // One failing flusher must not stop the others or the close.
    }
  }
}
