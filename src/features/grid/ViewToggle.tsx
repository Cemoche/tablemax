import { useEffect, useState } from "react";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";

export type TableView = "data" | "structure";

const VIEWS: { view: TableView; digit: string }[] = [
  { view: "data", digit: "1" },
  { view: "structure", digit: "2" },
];

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Which view of a table tab is shown. Alt+1 shows the rows, Alt+2 the structure (Option on
 * macOS, matched by physical key since Option+digit types a character there); not while
 * typing in a field or with a modal open. Only the active tab is mounted, so the shortcut
 * acts on it.
 */
export function useTableView() {
  const [view, setView] = useState<TableView>("data");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const hit = VIEWS.find(({ digit }) => e.code === `Digit${digit}` || e.key === digit);
      if (!hit) return;
      const t = e.target;
      if (t instanceof HTMLElement && (EDITABLE.has(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      // Capture + stop: the grid would take the digit as the start of a cell edit.
      e.stopPropagation();
      setView(hit.view);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return { view, setView };
}

/** The « Data | Structure » switch at the top of a table tab. */
export function ViewToggle({ view, onChange }: { view: TableView; onChange: (v: TableView) => void }) {
  const v = strings.grid.view;
  return (
    <div role="tablist" aria-label={v.label} className="flex border-b border-border bg-surface px-2 text-sm">
      {VIEWS.map(({ view: k, digit }) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={view === k}
          title={(k === "data" ? v.dataShortcut : v.structureShortcut)(formatShortcut(`Alt+${digit}`))}
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
