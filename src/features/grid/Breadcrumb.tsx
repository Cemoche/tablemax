import { Fragment, useEffect } from "react";
import { formatQuickFilter } from "../../lib/quickFilter";
import { strings } from "../../lib/strings";
import type { Filter, ObjectRef } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { back, backTo } from "./tableNavigation";

interface Props {
  workspaceId: string;
  tabId: string;
  /** What the tab shows now (the last item). */
  object: ObjectRef;
  filters: Filter[];
  /** Alt+← goes back only while the data view is shown (default true). */
  shortcut?: boolean;
}

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * The foreign keys followed in a table tab, `orders › customers (id = 42)`: an earlier item
 * goes back to that table exactly as it was; Alt+← goes back one step (not while typing in
 * a field, where it moves the caret on macOS). Nothing is shown with an empty trail.
 */
export function Breadcrumb({ workspaceId, tabId, object, filters, shortcut = true }: Props) {
  const trail = useGridViews((s) => s.trails[tabId]) ?? [];

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key !== "ArrowLeft") return;
      const t = e.target;
      if (t instanceof HTMLElement && (EDITABLE.has(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (useGridViews.getState().getTrail(tabId).length === 0) return;
      e.preventDefault();
      back(workspaceId, tabId);
    };
    // Capture: the grid handles arrow keys itself.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [workspaceId, tabId, shortcut]);

  if (trail.length === 0) return null;
  const crumb = (o: ObjectRef, f: Filter[]) => strings.grid.trail.crumb(o.name, formatQuickFilter(f));

  return (
    <nav
      aria-label={strings.grid.trail.label}
      title={strings.grid.trail.back}
      className="flex min-w-0 items-center gap-1 overflow-hidden border-b border-border bg-surface px-3 py-1 text-sm"
    >
      {trail.map((entry, i) => (
        <Fragment key={i}>
          <button
            type="button"
            onClick={() => backTo(workspaceId, tabId, i)}
            className="max-w-64 shrink-0 truncate rounded-sm px-1 text-accent hover:bg-surface-2"
          >
            {crumb(entry.object, entry.view.filters)}
          </button>
          <span aria-hidden="true" className="text-muted">
            {strings.grid.trail.separator}
          </span>
        </Fragment>
      ))}
      <span aria-current="page" className="min-w-0 truncate px-1 font-semibold">
        {crumb(object, filters)}
      </span>
    </nav>
  );
}
