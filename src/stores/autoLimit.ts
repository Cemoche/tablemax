import { create } from "zustand";
import { useWorkspaces } from "./workspaces";

/**
 * "Auto LIMIT" checkbox state of each SQL tab: in memory only, off by default, and not
 * part of the session snapshot (Plan 5 turns it into a setting).
 */
interface AutoLimitState {
  /** Tab ids with Auto LIMIT on. */
  on: Record<string, true>;
  setAutoLimit: (tabId: string, on: boolean) => void;
}

export const useAutoLimit = create<AutoLimitState>((set) => ({
  on: {},
  setAutoLimit: (tabId, on) =>
    set((s) => {
      const { [tabId]: _old, ...rest } = s.on;
      return { on: on ? { ...rest, [tabId]: true } : rest };
    }),
}));

// Forget closed tabs.
useWorkspaces.subscribe((state) => {
  const on = useAutoLimit.getState().on;
  const ids = Object.keys(on);
  if (ids.length === 0) return;
  const open = new Set(state.workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
  if (ids.some((id) => !open.has(id))) {
    useAutoLimit.setState({ on: Object.fromEntries(ids.filter((id) => open.has(id)).map((id) => [id, true])) });
  }
});
