import { useCallback, useEffect, useState } from "react";
import { isModKey } from "../../lib/platform";

/**
 * Whether the row details panel is shown: the toolbar button or Mod+I (Ctrl, Cmd on
 * macOS) toggles it, unless a modal is open. Only the active tab is mounted, so the
 * shortcut acts on it.
 */
export function useRowDetail() {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "i") return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { open, toggle, close: useCallback(() => setOpen(false), []) };
}
