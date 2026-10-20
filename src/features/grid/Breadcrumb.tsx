import { Fragment } from "react";
import { useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { formatQuickFilter } from "../../lib/quickFilter";
import { strings } from "../../lib/strings";
import type { Filter, FilterCombine, ObjectRef } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { backTo } from "./tableNavigation";

interface Props {
  workspaceId: string;
  tabId: string;
  /** What the tab shows now (the last item). */
  object: ObjectRef;
  filters: Filter[];
  /** How `filters` are joined (absent: AND). */
  combine?: FilterCombine;
}

/**
 * The foreign keys followed in a table tab, `orders › customers (id = 42)`: an earlier item
 * goes back to that table exactly as it was; the workspace's Back (`nav.back`, Alt+←, see
 * features/workspace/navigation) goes back one step first. Nothing is shown with an empty
 * trail.
 */
export function Breadcrumb({ workspaceId, tabId, object, filters, combine = "and" }: Props) {
  const trail = useGridViews((s) => s.trails[tabId]) ?? [];
  const backShortcut = useEffectiveShortcut("nav.back");

  if (trail.length === 0) return null;
  const crumb = (o: ObjectRef, f: Filter[], how: FilterCombine = "and") =>
    strings.grid.trail.crumb(o.name, formatQuickFilter(f, how));

  return (
    <nav
      aria-label={strings.grid.trail.label}
      title={strings.grid.trail.back(formatShortcut(backShortcut))}
      className="flex min-w-0 items-center gap-1 overflow-hidden border-b border-border bg-surface px-3 py-1 text-sm"
    >
      {trail.map((entry, i) => (
        <Fragment key={i}>
          <button
            type="button"
            onClick={() => backTo(workspaceId, tabId, i)}
            className="max-w-64 shrink-0 truncate rounded-sm px-1 text-accent hover:bg-surface-2"
          >
            {crumb(entry.object, entry.view.filters, entry.view.combine)}
          </button>
          <span aria-hidden="true" className="text-muted">
            {strings.grid.trail.separator}
          </span>
        </Fragment>
      ))}
      <span aria-current="page" className="min-w-0 truncate px-1 font-semibold">
        {crumb(object, filters, combine)}
      </span>
    </nav>
  );
}
