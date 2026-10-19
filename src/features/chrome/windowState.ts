import { useEffect } from "react";
import * as ipc from "../../lib/ipc";
import { onWindowResized } from "../../lib/windowResize";
import { useChrome } from "../../stores/chrome";

/** Asks Rust whether the window is maximized and stores it (a failure keeps the last value). */
function refreshMaximized() {
  void ipc
    .windowIsMaximized()
    ?.then((m) => useChrome.getState().setMaximized(m === true))
    .catch(() => {});
}

/** Maximizes or restores the window and stores the new state. */
export function toggleMaximize() {
  void ipc
    .windowToggleMaximize()
    ?.then((m) => useChrome.getState().setMaximized(m === true))
    .catch(() => {});
}

/**
 * Keeps `useChrome().maximized` in step with the window: at mount, then after each resize
 * (maximize or restore from the desktop: snapping, keyboard, the system title bar).
 */
export function useTrackMaximized() {
  useEffect(() => {
    refreshMaximized();
    let unlisten: (() => void) | null = null;
    let live = true;
    void onWindowResized(refreshMaximized).then((u) => {
      if (live) unlisten = u;
      else u();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);
}
