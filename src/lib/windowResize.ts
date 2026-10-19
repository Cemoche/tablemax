/**
 * Resize events of the calling window (`tauri://resize`, allowed by core:default): the
 * frameless window's toolbar follows maximize / restore done by the desktop (snapping,
 * keyboard). This wrapper exists so tests can mock the event API; outside Tauri
 * (`pnpm web`, tests) it does nothing.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Calls `handler` on each resize of this window; resolves to the unlisten function. */
export async function onWindowResized(handler: () => void): Promise<() => void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  try {
    return await getCurrentWindow().onResized(() => handler());
  } catch {
    return () => {};
  }
}
