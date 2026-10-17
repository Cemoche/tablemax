import { useCallback, useState } from "react";
import { useAction } from "../../lib/keymap";

/**
 * Whether the row details panel is shown: the toolbar button or `grid.rowDetails` (Mod+I:
 * Ctrl, Cmd on macOS) toggles it, unless a modal is open or `shortcut` is false (the data
 * view is hidden). Only the active tab is mounted, so the shortcut acts on it.
 */
export function useRowDetail(shortcut = true) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useAction("grid.rowDetails", toggle, { enabled: shortcut });

  return { open, toggle, close: useCallback(() => setOpen(false), []) };
}
