import { useCallback, useEffect } from "react";
import { useAction } from "../../lib/keymap";
import { useChrome } from "../../stores/chrome";

/**
 * Whether the row details panel of table tab `tabId` is shown (chrome store, so the
 * toolbar button reads and toggles it too): the toolbar, the tab's own button or
 * `grid.rowDetails` (Mod+I: Ctrl, Cmd on macOS) toggles it, unless a modal is open or
 * `shortcut` is false (the data view is hidden). Only the active tab is mounted, so the
 * shortcut acts on it. The panel starts closed each time the tab mounts.
 */
export function useRowDetail(tabId: string, shortcut = true) {
  const open = useChrome((s) => s.rowDetails[tabId] === true);
  const toggle = useCallback(() => useChrome.getState().toggleRowDetails(tabId), [tabId]);
  const close = useCallback(() => useChrome.getState().setRowDetails(tabId, false), [tabId]);

  useEffect(() => close, [close]);
  useAction("grid.rowDetails", toggle, { enabled: shortcut });

  return { open, toggle, close };
}
