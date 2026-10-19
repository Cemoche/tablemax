import { useEffect, useRef } from "react";

/**
 * For a modal dialog: remembers the element that had the focus when the dialog rendered
 * (before its own autofocus moves it) and focuses it again when the dialog unmounts, if it is
 * still connected, enabled and not inside a hidden subtree. A dialog whose closing already
 * decides where the focus goes (the grid commit confirmation) runs its own effect after this
 * cleanup in the same commit, so its choice wins.
 */
export function useRestoreFocus(): void {
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement;
  useEffect(() => {
    const el = opener.current;
    return () => {
      // Only when the focus fell to body (the dialog's own element was removed). Under
      // StrictMode's simulated unmount the dialog still holds the focus, and a focus that
      // moved elsewhere is not ours to take.
      const now = document.activeElement;
      if (now && now !== document.body) return;
      if (
        el instanceof HTMLElement &&
        el !== document.body &&
        el.isConnected &&
        !el.closest("[hidden]") &&
        !(el as HTMLButtonElement).disabled
      ) {
        el.focus();
      }
    };
  }, []);
}
