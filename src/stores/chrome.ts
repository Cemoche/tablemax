import { useEffect, useRef } from "react";
import { create } from "zustand";

/** What a toolbar button asks the command palette to show. */
export interface PaletteRequest {
  kind: "all" | "database";
  /** Bumped per request, so the same kind twice opens twice. */
  seq: number;
}

/**
 * Requests from the window's toolbar (features/chrome) to the parts that own the state:
 * the table tab (row details, page reload), its pending changes panel (Preview), the
 * sidebar (reload) and the command palette. Counters are bumped per request; a component
 * acts on a change, never on the value it mounted with.
 */
interface ChromeState {
  /** Row details panel shown, per table tab id (false again when the tab unmounts). */
  rowDetails: Record<string, boolean>;
  toggleRowDetails: (tabId: string) => void;
  setRowDetails: (tabId: string, open: boolean) => void;
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
  tableViews: Record<string, "data" | "structure">;
  setTableView: (tabId: string, view: "data" | "structure") => void;
  dropTableView: (tabId: string) => void;
}

const bump = (m: Record<string, number>, id: string) => ({ ...m, [id]: (m[id] ?? 0) + 1 });

const omit = <T,>(m: Record<string, T>, id: string): Record<string, T> => {
  const c = { ...m };
  delete c[id];
  return c;
};

export const useChrome = create<ChromeState>((set, get) => ({
  rowDetails: {},
  toggleRowDetails: (tabId) => set((s) => ({ rowDetails: { ...s.rowDetails, [tabId]: !s.rowDetails[tabId] } })),
  setRowDetails: (tabId, open) =>
    set((s) => (!!s.rowDetails[tabId] === open ? s : { rowDetails: { ...s.rowDetails, [tabId]: open } })),
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
