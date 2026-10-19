/**
 * The backend holds the main window's close back and asks the frontend to flush its
 * session first (event `session-flush-requested`). This wrapper exists so tests can mock
 * the event API; outside Tauri (`pnpm web`, tests) it does nothing.
 */
import { listen } from "@tauri-apps/api/event";

const FLUSH_EVENT = "session-flush-requested";

/** Calls `handler` on each close request; resolves to the unlisten function. */
export async function onFlushRequested(handler: () => void): Promise<() => void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  try {
    return await listen(FLUSH_EVENT, () => handler());
  } catch {
    return () => {};
  }
}
