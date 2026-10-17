import { useState } from "react";
import { useAction, useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import type { ShortcutOptions } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";

export type TableView = "data" | "structure";

const VIEWS: TableView[] = ["data", "structure"];

// Capture + stop: the grid would take the digit as the start of a cell edit.
const VIEW_KEYS: ShortcutOptions = { capture: true, stopPropagation: true, skipInEditable: true };

/**
 * Which view of a table tab is shown. `grid.viewData` (Alt+1) shows the rows,
 * `grid.viewStructure` (Alt+2) the structure (Option on macOS, matched by physical key since
 * Option+digit types a character there); not while typing in a field or with a modal open.
 * Only the active tab is mounted, so the shortcut acts on it.
 */
export function useTableView() {
  const [view, setView] = useState<TableView>("data");
  useAction("grid.viewData", () => setView("data"), VIEW_KEYS);
  useAction("grid.viewStructure", () => setView("structure"), VIEW_KEYS);
  return { view, setView };
}

/** The « Data | Structure » switch at the top of a table tab. */
export function ViewToggle({ view, onChange }: { view: TableView; onChange: (v: TableView) => void }) {
  const v = strings.grid.view;
  const shortcuts: Record<TableView, string> = {
    data: useEffectiveShortcut("grid.viewData"),
    structure: useEffectiveShortcut("grid.viewStructure"),
  };
  return (
    <div role="tablist" aria-label={v.label} className="flex border-b border-border bg-surface px-2 text-sm">
      {VIEWS.map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={view === k}
          title={(k === "data" ? v.dataShortcut : v.structureShortcut)(formatShortcut(shortcuts[k]))}
          onClick={() => onChange(k)}
          className={`border-b-2 px-3 py-1 ${
            view === k ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
          }`}
        >
          {k === "data" ? v.data : v.structure}
        </button>
      ))}
    </div>
  );
}
