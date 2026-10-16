import { create } from "zustand";
import type { SortDir } from "../lib/types";

export interface GridView {
  page: number;
  sort: [string, SortDir] | null;
}

const DEFAULT_VIEW: GridView = { page: 0, sort: null };

interface GridViewsState {
  views: Record<string, GridView>;
  getView: (tabId: string) => GridView;
  setView: (tabId: string, patch: Partial<GridView>) => void;
  dropView: (tabId: string) => void;
}

/** Per-tab page/sort, kept outside the component so it survives tab switches. */
export const useGridViews = create<GridViewsState>((set, get) => ({
  views: {},
  getView: (tabId) => get().views[tabId] ?? DEFAULT_VIEW,
  setView: (tabId, patch) =>
    set((s) => ({
      views: { ...s.views, [tabId]: { ...(s.views[tabId] ?? DEFAULT_VIEW), ...patch } },
    })),
  dropView: (tabId) =>
    set((s) => {
      if (!(tabId in s.views)) return s;
      const views = { ...s.views };
      delete views[tabId];
      return { views };
    }),
}));
