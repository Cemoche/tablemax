// Foreign key navigation inside one table tab: the tab's object (workspaces), its view and
// its trail (gridViews) change together. Refused, like a page change, while changes are
// pending (guardPending flags the tab with the reason).
import type { Filter, ObjectRef } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { guardPending } from "../../stores/pendingChanges";
import { useWorkspaces } from "../../stores/workspaces";

/**
 * Shows `to` filtered by `filters` (page 0, no sort) in the tab, after pushing what the tab
 * shows now (`from` and its view) on the trail. False when refused.
 */
export function openReferenced(
  workspaceId: string,
  tabId: string,
  from: ObjectRef,
  to: ObjectRef,
  filters: Filter[],
): boolean {
  if (!guardPending(tabId)) return false;
  const views = useGridViews.getState();
  views.pushTrail(tabId, { object: from, view: views.getView(tabId) });
  views.setView(tabId, { page: 0, sort: null, filters });
  useWorkspaces.getState().navigateTableTab(workspaceId, tabId, to);
  return true;
}

/**
 * Goes back to trail entry `index`: its object and its exact view (filters, sort, page);
 * the entries after it are dropped. False when there is no such entry or when refused.
 */
export function backTo(workspaceId: string, tabId: string, index: number): boolean {
  const views = useGridViews.getState();
  const entry = views.getTrail(tabId)[index];
  if (!entry || !guardPending(tabId)) return false;
  views.truncateTrail(tabId, index);
  views.setView(tabId, entry.view);
  useWorkspaces.getState().navigateTableTab(workspaceId, tabId, entry.object);
  return true;
}

/** One step back (Alt+←); false with an empty trail or when refused. */
export function back(workspaceId: string, tabId: string): boolean {
  return backTo(workspaceId, tabId, useGridViews.getState().getTrail(tabId).length - 1);
}
