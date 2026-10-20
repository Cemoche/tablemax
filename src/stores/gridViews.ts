import { create } from "zustand";
import type { ColumnLayout } from "../lib/columnLayout";
import type { Filter, ObjectRef, SortDir } from "../lib/types";

export interface GridView {
  page: number;
  sort: [string, SortDir] | null;
  /** Joined by AND; changing them goes back to page 0 (usePagedTable.setFilters). */
  filters: Filter[];
  /** The page size the tab latched (usePagedTable); absent = the current setting. */
  pageSize?: number;
}

/** A table a tab showed before following a foreign key, with its view at that moment. */
export interface TrailEntry {
  object: ObjectRef;
  view: GridView;
}

const DEFAULT_VIEW: GridView = { page: 0, sort: null, filters: [] };
const NO_TRAIL: TrailEntry[] = [];

interface GridViewsState {
  views: Record<string, GridView>;
  /** Per tab, the tables left by following foreign keys (oldest first). */
  trails: Record<string, TrailEntry[]>;
  getView: (tabId: string) => GridView;
  setView: (tabId: string, patch: Partial<GridView>) => void;
  getTrail: (tabId: string) => TrailEntry[];
  /** Replaces the tab's view and trail at once (foreign key navigation, see workspaces). */
  setNavigation: (tabId: string, view: GridView, trail: TrailEntry[]) => void;
  /** Forgets the tab's view and trail. */
  dropView: (tabId: string) => void;
  /**
   * Column widths, order and hidden columns per table (key: connection, database, schema,
   * table), kept for the session across tabs. Read them through `reconcileLayout`: the
   * table's columns may have changed since.
   */
  layouts: Record<string, ColumnLayout>;
  setLayout: (key: string, patch: Partial<ColumnLayout>) => void;
  /** Forgets one part of a table's layout (Reset positions: the order). */
  resetLayout: (key: string, part: keyof ColumnLayout) => void;
}

const EMPTY_LAYOUT: ColumnLayout = { widths: {}, order: [], hidden: [] };

const omit = <T,>(r: Record<string, T>, key: string) => {
  const c = { ...r };
  delete c[key];
  return c;
};

/** Per-tab page/sort/filters and trail, kept outside the component so they survive tab switches. */
export const useGridViews = create<GridViewsState>((set, get) => ({
  views: {},
  trails: {},
  getView: (tabId) => get().views[tabId] ?? DEFAULT_VIEW,
  setView: (tabId, patch) =>
    set((s) => ({
      views: { ...s.views, [tabId]: { ...(s.views[tabId] ?? DEFAULT_VIEW), ...patch } },
    })),
  getTrail: (tabId) => get().trails[tabId] ?? NO_TRAIL,
  setNavigation: (tabId, view, trail) =>
    set((s) => ({ views: { ...s.views, [tabId]: view }, trails: { ...s.trails, [tabId]: trail } })),
  dropView: (tabId) =>
    set((s) => {
      if (!(tabId in s.views) && !(tabId in s.trails)) return s;
      return { views: omit(s.views, tabId), trails: omit(s.trails, tabId) };
    }),
  layouts: {},
  setLayout: (key, patch) =>
    set((s) => ({
      layouts: { ...s.layouts, [key]: { ...(s.layouts[key] ?? EMPTY_LAYOUT), ...patch } },
    })),
  resetLayout: (key, part) =>
    set((s) => ({
      layouts: { ...s.layouts, [key]: { ...(s.layouts[key] ?? EMPTY_LAYOUT), [part]: EMPTY_LAYOUT[part] } },
    })),
}));
