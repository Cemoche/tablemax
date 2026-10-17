import { create } from "zustand";

/**
 * Side panels of the SQL tab (Plan 4 Task 8): the history panel is per tab (Mod+Shift+H,
 * palette "Open history"); the saved-queries list is one app-wide collapsible section.
 */
interface QueryPanelsState {
  /** Tab id -> history panel shown. */
  history: Record<string, boolean>;
  savedOpen: boolean;
  toggleHistory: (tabId: string) => void;
  setHistory: (tabId: string, open: boolean) => void;
  toggleSaved: () => void;
}

export const useQueryPanels = create<QueryPanelsState>((set) => ({
  history: {},
  savedOpen: true,
  toggleHistory: (tabId) => set((s) => ({ history: { ...s.history, [tabId]: !s.history[tabId] } })),
  setHistory: (tabId, open) => set((s) => ({ history: { ...s.history, [tabId]: open } })),
  toggleSaved: () => set((s) => ({ savedOpen: !s.savedOpen })),
}));
