import { ChevronLeft, ChevronRight, Columns3, ListFilter, Settings2 } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { type KeymapActionId, useAction, useEffectiveShortcut } from "../../lib/keymap";
import { ariaShortcut, formatShortcut } from "../../lib/platform";
import type { ShortcutOptions } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { useChrome } from "../../stores/chrome";
import { ColumnsPopover } from "./ColumnsPopover";
import { PagePopover } from "./PagePopover";

export type TableView = "data" | "structure" | "index";

const VIEWS: TableView[] = ["data", "structure", "index"];

// Capture + stop: the grid would take the digit as the start of a cell edit.
const VIEW_KEYS: ShortcutOptions = { capture: true, stopPropagation: true, skipInEditable: true };

/**
 * Which view of a table tab is shown. `grid.viewData` (Alt+1; also ⌘⌥[ on macOS) shows the
 * rows, `grid.viewStructure` (Alt+2; also ⌘⌥]) the structure, `grid.viewIndex` (Alt+3) the
 * indexes (Option on macOS, matched by physical key since Option+digit types a character
 * there); not while typing in a field or with a modal open. Only the active tab is mounted, so the shortcut acts on it. The view
 * lives in the chrome store, per tab: it survives the unmount of a tab or workspace switch,
 * and the sidebar's "Open structure" sets it.
 */
export function useTableView(tabId: string) {
  const view: TableView = useChrome((s) => s.tableViews[tabId]) ?? "data";
  const setView = (v: TableView) => useChrome.getState().setTableView(tabId, v);
  useAction("grid.viewData", () => setView("data"), VIEW_KEYS);
  useAction("grid.viewStructure", () => setView("structure"), VIEW_KEYS);
  useAction("grid.viewIndex", () => setView("index"), VIEW_KEYS);
  return { view, setView };
}

/** What the bar shows next to the view switch while the rows are shown. */
export interface BottomBarData {
  /** + Row; absent for a read-only table. */
  addRow?: { onClick: () => void; disabled: boolean; ref: RefObject<HTMLButtonElement | null> };
  /** "1–300 of 1,250 rows". */
  counter: string;
  /** A page is loading. */
  busy: boolean;
  filters: {
    open: boolean;
    /** Applied filters. */
    count: number;
    /** The filter bar's id. */
    controls: string;
    onToggle: () => void;
    ref: RefObject<HTMLButtonElement | null>;
  };
  columns: {
    /** The table's columns. */
    names: string[];
    layoutKey: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
  paging: {
    hasPrev: boolean;
    hasNext: boolean;
    /** Loading: no page change. */
    disabled: boolean;
    onPrev: () => void;
    onNext: () => void;
    offset: number;
    limit: number;
    /** False when refused (changes pending). */
    onGo: (offset: number, limit: number) => boolean;
  };
}

interface Props {
  view: TableView;
  onView: (v: TableView) => void;
  /** The view switch (the commit confirmation gives the focus back to its selected tab). */
  tabsRef?: RefObject<HTMLDivElement | null>;
  /** The ids of the views' panels (one the tab has not shown yet is not there). */
  panelIds: Partial<Record<TableView, string>>;
  /** Null while the structure is shown: only the view switch then. */
  data: BottomBarData | null;
}

/** 26 px controls of the 42 px bar (spec §5.2), the toolbar's look. */
const control =
  "flex h-6.5 shrink-0 items-center justify-center gap-1 rounded-md border border-pill-border bg-btn px-2 text-sm text-text outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent disabled:text-icon-dim disabled:hover:bg-btn aria-expanded:bg-seg-sel";
const ICON = { size: 15, strokeWidth: 1.6, "aria-hidden": true } as const;
const VIEW_TEXT: Record<TableView, { label: string; hint: (shortcut: string) => string }> = {
  data: { label: strings.grid.view.data, hint: strings.grid.view.dataShortcut },
  structure: { label: strings.grid.view.structure, hint: strings.grid.view.structureShortcut },
  index: { label: strings.grid.view.index, hint: strings.grid.view.indexShortcut },
};

/**
 * The bar under the grid (spec §2.3): [Data | Structure] · + Row · the row counter, centered ·
 * Filters · Columns · [‹ | offset and limit | ›].
 */
export function TableBottomBar({ view, onView, tabsRef, panelIds, data }: Props) {
  const v = strings.grid.view;
  const g = strings.grid;
  const shortcut = {
    data: useEffectiveShortcut("grid.viewData"),
    structure: useEffectiveShortcut("grid.viewStructure"),
    index: useEffectiveShortcut("grid.viewIndex"),
    addRow: useEffectiveShortcut("grid.addRow"),
    filters: useEffectiveShortcut("grid.filters"),
    columns: useEffectiveShortcut("grid.columns"),
    prev: useEffectiveShortcut("grid.previousPage"),
    next: useEffectiveShortcut("grid.nextPage"),
  } satisfies Record<string, string>;
  const keys = (spec: string) => ariaShortcut(spec);

  // Arrows move the selection (and the focus) along the switch; one Tab stop.
  const focusTab = useRef(false);
  const tabRefs = useRef<Partial<Record<TableView, HTMLButtonElement | null>>>({});
  useEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    tabRefs.current[view]?.focus();
  }, [view]);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = VIEWS.indexOf(view);
    const next =
      e.key === "ArrowRight" ? VIEWS[(at + 1) % VIEWS.length]
      : e.key === "ArrowLeft" ? VIEWS[(at + VIEWS.length - 1) % VIEWS.length]
      : e.key === "Home" ? VIEWS[0]
      : e.key === "End" ? VIEWS[VIEWS.length - 1]
      : null;
    if (next === null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    if (next === view) return;
    focusTab.current = true;
    onView(next);
  };

  return (
    <div
      role="group"
      aria-label={g.bottomBar}
      className="grid h-10.5 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-sep bg-bottom px-2 text-sm text-text"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div ref={tabsRef} role="tablist" aria-label={v.label} className="flex h-6.5 shrink-0 rounded-md border border-pill-border bg-btn p-px">
          {VIEWS.map((k) => (
            <button
              key={k}
              ref={(el) => {
                tabRefs.current[k] = el;
              }}
              type="button"
              role="tab"
              aria-selected={view === k}
              aria-controls={panelIds[k]}
              tabIndex={view === k ? 0 : -1}
              title={VIEW_TEXT[k].hint(formatShortcut(shortcut[k]))}
              aria-keyshortcuts={keys(shortcut[k])}
              onClick={() => onView(k)}
              onKeyDown={onTabKey}
              className="rounded-[5px] px-2.5 text-text outline-none aria-selected:bg-accent aria-selected:text-accent-contrast focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              {VIEW_TEXT[k].label}
            </button>
          ))}
        </div>
        {data?.addRow && (
          <button
            ref={data.addRow.ref}
            type="button"
            className={control}
            title={g.addRowShortcut(formatShortcut(shortcut.addRow))}
            aria-keyshortcuts={keys(shortcut.addRow)}
            onClick={data.addRow.onClick}
            disabled={data.addRow.disabled}
          >
            {g.addRow}
          </button>
        )}
      </div>
      {data ? (
        <span
          data-testid="footer-range"
          aria-live="polite"
          aria-busy={data.busy}
          className={`truncate text-center tabular-nums ${data.busy ? "text-text-2" : ""}`}
        >
          {data.counter}
        </span>
      ) : (
        <span />
      )}
      {data && <DataControls data={data} shortcut={shortcut} />}
    </div>
  );
}

function DataControls({
  data,
  shortcut,
}: {
  data: BottomBarData;
  shortcut: Record<"filters" | "columns" | "prev" | "next", string>;
}) {
  const g = strings.grid;
  const keys = (spec: string) => ariaShortcut(spec);
  const columnsRef = useRef<HTMLButtonElement>(null);
  const pageRef = useRef<HTMLButtonElement>(null);
  const [pageOpen, setPageOpen] = useState(false);
  const { filters, columns, paging } = data;
  const pageButton = (label: string, action: KeymapActionId, spec: string, enabled: boolean, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={g.pageShortcut(label, formatShortcut(spec))}
      aria-keyshortcuts={keys(spec)}
      className={`${control} w-7 px-0`}
      disabled={!enabled || paging.disabled}
      onClick={onClick}
    >
      {action === "grid.previousPage" ? <ChevronLeft {...ICON} /> : <ChevronRight {...ICON} />}
    </button>
  );
  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <button
        ref={filters.ref}
        type="button"
        className={control}
        aria-expanded={filters.open}
        aria-controls={filters.open ? filters.controls : undefined}
        title={g.filtersShortcut(formatShortcut(shortcut.filters))}
        aria-keyshortcuts={keys(shortcut.filters)}
        onClick={filters.onToggle}
      >
        <ListFilter {...ICON} />
        <span>{strings.filters.button(filters.count)}</span>
      </button>
      <div className="relative">
        <button
          ref={columnsRef}
          type="button"
          className={control}
          aria-haspopup="dialog"
          aria-expanded={columns.open}
          title={g.columnsShortcut(formatShortcut(shortcut.columns))}
          aria-keyshortcuts={keys(shortcut.columns)}
          onClick={() => columns.onOpenChange(!columns.open)}
        >
          <Columns3 {...ICON} />
          <span>{g.columns}</span>
        </button>
        {columns.open && (
          <ColumnsPopover
            columns={columns.names}
            layoutKey={columns.layoutKey}
            onClose={(refocus) => {
              columns.onOpenChange(false);
              if (refocus) columnsRef.current?.focus();
            }}
          />
        )}
      </div>
      <div className="relative flex items-center gap-px">
        {pageButton(g.prev, "grid.previousPage", shortcut.prev, paging.hasPrev, paging.onPrev)}
        <button
          ref={pageRef}
          type="button"
          aria-label={g.pageSettings}
          title={g.pageSettings}
          aria-haspopup="dialog"
          aria-expanded={pageOpen}
          className={`${control} w-7 px-0`}
          onClick={() => setPageOpen((o) => !o)}
        >
          <Settings2 {...ICON} />
        </button>
        {pageButton(g.next, "grid.nextPage", shortcut.next, paging.hasNext, paging.onNext)}
        {pageOpen && (
          <PagePopover
            offset={paging.offset}
            limit={paging.limit}
            onGo={paging.onGo}
            onClose={(refocus) => {
              setPageOpen(false);
              if (refocus) pageRef.current?.focus();
            }}
          />
        )}
      </div>
    </div>
  );
}
