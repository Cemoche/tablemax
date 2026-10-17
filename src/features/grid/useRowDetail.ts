import { useCallback, useEffect, useState } from "react";
import { isModKey } from "../../lib/platform";

/**
 * Whether the row details panel is shown: the toolbar button or Mod+I (Ctrl, Cmd on
 * macOS) toggles it, unless a modal is open or `shortcut` is false (the data view is
 * hidden). Only the active tab is mounted, so the shortcut acts on it.
 */
export function useRowDetail(shortcut = true) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "i") return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, shortcut]);

  return { open, toggle, close: useCallback(() => setOpen(false), []) };
}
