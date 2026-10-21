import { useCallback } from "react";
import { useAction } from "../../lib/keymap";
import { useChrome } from "../../stores/chrome";

/**
 * Whether the row details panel is shown. It is one switch for the window (chrome store,
 * read and toggled by the toolbar button too), so it stays open across tab and workspace
 * switches (#79). The active table tab binds `grid.rowDetails` (Ctrl+Space; Space in the
 * grid, see DataGrid) to it, unless a modal is open or `shortcut` is false (the data view
 * is hidden). Only the active tab of the active workspace is mounted, so exactly one tab
 * binds it at a time. The grid also takes the key itself while it has the focus (its
 * keydown). A SQL tab binds nothing to the window, which leaves Ctrl+Space to the editor's
 * completion: there only its results grid (while focused) and the toolbar button toggle
 * the panel (#115).
 */
export function useRowDetail(shortcut = true) {
  const open = useChrome((s) => s.rowDetailsOpen);
  const toggle = useCallback(() => useChrome.getState().toggleRowDetails(), []);
  const close = useCallback(() => useChrome.getState().setRowDetails(false), []);

  useAction("grid.rowDetails", toggle, { enabled: shortcut });

  return { open, toggle, close };
}
