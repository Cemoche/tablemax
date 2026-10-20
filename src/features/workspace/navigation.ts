// Back / forward in a workspace (spec §5.3, Alt+← / Alt+→, and the tab bar's arrows): a table
// tab showing its rows first goes back along its foreign key trail, then the workspace's
// history of visited tabs (stores/workspaces).
import { useAction } from "../../lib/keymap";
import { useChrome } from "../../stores/chrome";
import { useGridViews } from "../../stores/gridViews";
import { type Workspace, canNavigate, useWorkspaces } from "../../stores/workspaces";
import { back } from "../grid/tableNavigation";

/** The active table tab whose foreign key trail Back would follow, or null. */
function trailTab(w: Workspace, trails: Record<string, unknown[]>, views: Record<string, string>): string | null {
  const tab = w.tabs.find((t) => t.id === w.activeTabId);
  if (tab?.kind !== "table" || (views[tab.id] ?? "data") !== "data") return null;
  return (trails[tab.id]?.length ?? 0) > 0 ? tab.id : null;
}

/** Goes one step back: the trail of the table shown, else the previous tab visited. */
export function goBack(wsId: string): void {
  const w = useWorkspaces.getState().workspaces.find((x) => x.id === wsId);
  if (!w) return;
  const tabId = trailTab(w, useGridViews.getState().trails, useChrome.getState().tableViews);
  // A trail step refused (pending changes) flags the tab; it does not skip to another tab.
  if (tabId) back(wsId, tabId);
  else useWorkspaces.getState().navigate(wsId, -1);
}

export function goForward(wsId: string): void {
  useWorkspaces.getState().navigate(wsId, 1);
}

/** Can the workspace go back / forward? Re-renders when the trail or the view changes. */
export function useCanNavigate(w: Workspace): { back: boolean; forward: boolean } {
  const trails = useGridViews((s) => s.trails);
  const views = useChrome((s) => s.tableViews);
  return {
    back: trailTab(w, trails, views) !== null || canNavigate(w, -1),
    forward: canNavigate(w, 1),
  };
}

/**
 * Binds `nav.back` / `nav.forward` for the workspace: not while typing in a field or the SQL
 * editor (Alt+arrows move the caret there), in the capture phase so the grid does not take
 * them first.
 */
export function useNavigationShortcuts(wsId: string, enabled: boolean): void {
  const opts = { capture: true, stopPropagation: true, skipInEditable: true, enabled };
  useAction("nav.back", () => goBack(wsId), opts);
  useAction("nav.forward", () => goForward(wsId), opts);
}
