import { useEffect, useRef } from "react";
import { create } from "zustand";

/** What a toolbar button asks the command palette to show. */
export interface PaletteRequest {
  kind: "all" | "database";
  /** Bumped per request, so the same kind twice opens twice. */
  seq: number;
}

/** Spec §5.2: the row details panel is 280 px wide by default, never under 240. */
export const ROW_DETAILS_DEFAULT = 280;
export const ROW_DETAILS_MIN = 240;
export const ROW_DETAILS_MAX = 720;
/** The width is a per-machine convenience, like the sidebar's. */
export const ROW_DETAILS_WIDTH_KEY = "tablemax.rowDetailsWidth";

export const clampRowDetailsWidth = (px: number) =>
  Math.round(Math.min(ROW_DETAILS_MAX, Math.max(ROW_DETAILS_MIN, px)));

/** The width saved by the last session, or the default. */
export function loadRowDetailsWidth(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(ROW_DETAILS_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(n) ? clampRowDetailsWidth(n) : ROW_DETAILS_DEFAULT;
  } catch {
    return ROW_DETAILS_DEFAULT;
  }
}

/**
 * Requests from the window's toolbar (features/chrome) to the parts that own the state:
 * the table tab (row details, page reload), its pending changes panel (Preview), the
 * sidebar (reload) and the command palette. Counters are bumped per request; a component
 * acts on a change, never on the value it mounted with.
 */
interface ChromeState {
  /**
   * The row details panel is shown (one switch for the window, like the toolbar button that
   * reads it): every table tab showing its rows shows it, so it stays open across tab and
   * workspace switches (#79). For the session only.
   */
  rowDetailsOpen: boolean;
  toggleRowDetails: () => void;
  setRowDetails: (open: boolean) => void;
  /** The panel's width (px), saved for the next start by `saveRowDetailsWidth`. */
  rowDetailsWidth: number;
  /** Clamps and applies (a drag calls it on every move). */
  setRowDetailsWidth: (px: number) => void;
  /** Saves the width (once, at the end of a drag or a key press). */
  saveRowDetailsWidth: () => void;
  /** Reload requests: a workspace id (its sidebar) or a table tab id (its page). */
  reloads: Record<string, number>;
  requestReload: (id: string) => void;
  /** Requests to show a table tab's pending changes and their SQL. */
  previews: Record<string, number>;
  requestPreview: (tabId: string) => void;
  paletteRequest: PaletteRequest | null;
  requestPalette: (kind: PaletteRequest["kind"]) => void;
  /** The frameless window is maximized (Restore label, no resize grips). */
  maximized: boolean;
  setMaximized: (maximized: boolean) => void;
  /** Requests to open the settings dialog (the sidebar's gear; App owns the dialog). */
  settingsRequest: number;
  requestSettings: () => void;
  /** Bumped when a run of a connection ended: its sidebar History reloads. */
  historyBumps: Record<string, number>;
  bumpHistory: (connectionId: string) => void;
  /**
   * One-shot requests to a SQL tab, consumed by the tab (also when it mounts after the
   * request, e.g. a tab just opened): run all of it, insert text at the cursor.
   */
  runRequests: Record<string, number>;
  requestRun: (tabId: string) => void;
  takeRun: (tabId: string) => boolean;
  editorInserts: Record<string, string>;
  requestInsert: (tabId: string, sql: string) => void;
  takeInsert: (tabId: string) => string | null;
  /**
   * The view each table tab shows (absent: Data). Kept here, not in the tab's component:
   * only the active tab of the active workspace is mounted, so a tab or workspace switch
   * unmounts it. Set by the tab's switch and by the sidebar's "Open structure"; dropped
   * when the tab closes (workspaces).
   */
  tableViews: Record<string, "data" | "structure" | "index">;
  setTableView: (tabId: string, view: "data" | "structure" | "index") => void;
  dropTableView: (tabId: string) => void;
}

const bump = (m: Record<string, number>, id: string) => ({ ...m, [id]: (m[id] ?? 0) + 1 });

const omit = <T,>(m: Record<string, T>, id: string): Record<string, T> => {
  const c = { ...m };
  delete c[id];
  return c;
};

export const useChrome = create<ChromeState>((set, get) => ({
  rowDetailsOpen: false,
  toggleRowDetails: () => set((s) => ({ rowDetailsOpen: !s.rowDetailsOpen })),
  setRowDetails: (open) => set({ rowDetailsOpen: open }),
  rowDetailsWidth: loadRowDetailsWidth(),
  setRowDetailsWidth: (px) => set({ rowDetailsWidth: clampRowDetailsWidth(px) }),
  saveRowDetailsWidth: () => {
    try {
      localStorage.setItem(ROW_DETAILS_WIDTH_KEY, String(get().rowDetailsWidth));
    } catch {
      // Storage unavailable: the width only lasts for this session.
    }
  },
  reloads: {},
  requestReload: (id) => set((s) => ({ reloads: bump(s.reloads, id) })),
  previews: {},
  requestPreview: (tabId) => set((s) => ({ previews: bump(s.previews, tabId) })),
  paletteRequest: null,
  requestPalette: (kind) => set((s) => ({ paletteRequest: { kind, seq: (s.paletteRequest?.seq ?? 0) + 1 } })),
  maximized: false,
  setMaximized: (maximized) => set({ maximized }),
  settingsRequest: 0,
  requestSettings: () => set((s) => ({ settingsRequest: s.settingsRequest + 1 })),
  historyBumps: {},
  bumpHistory: (connectionId) => set((s) => ({ historyBumps: bump(s.historyBumps, connectionId) })),
  runRequests: {},
  requestRun: (tabId) => set((s) => ({ runRequests: bump(s.runRequests, tabId) })),
  takeRun: (tabId) => {
    if (!get().runRequests[tabId]) return false;
    set((s) => ({ runRequests: omit(s.runRequests, tabId) }));
    return true;
  },
  editorInserts: {},
  requestInsert: (tabId, sql) => set((s) => ({ editorInserts: { ...s.editorInserts, [tabId]: sql } })),
  takeInsert: (tabId) => {
    const sql = get().editorInserts[tabId];
    if (sql === undefined) return null;
    set((s) => ({ editorInserts: omit(s.editorInserts, tabId) }));
    return sql;
  },
  tableViews: {},
  setTableView: (tabId, view) =>
    set((s) => (s.tableViews[tabId] === view ? s : { tableViews: { ...s.tableViews, [tabId]: view } })),
  dropTableView: (tabId) => set((s) => (tabId in s.tableViews ? { tableViews: omit(s.tableViews, tabId) } : s)),
}));

/**
 * Runs `fn` each time the counter `value` changes after mount (not for the value the
 * component mounted with).
 */
export function useOnRequest(value: number, fn: () => void): void {
  const seen = useRef(value);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (value === seen.current) return;
    seen.current = value;
    fnRef.current();
  }, [value]);
}
