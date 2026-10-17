import { create } from "zustand";
import { applyAutoLimit } from "../features/editor/autoLimit";
import type { Dialect } from "../lib/types";
import { useSettings } from "./settings";
import { useWorkspaces } from "./workspaces";

/**
 * "Auto LIMIT" checkbox of each SQL tab. A tab follows `settings.autoLimitDefault` until
 * the user toggles its checkbox: that explicit choice is an override, kept in memory only
 * (not part of the session snapshot) and forgotten when the tab closes.
 */
interface AutoLimitState {
  /** Tabs whose checkbox was toggled by hand, with the chosen value. */
  override: Record<string, boolean>;
  setAutoLimit: (tabId: string, on: boolean) => void;
}

export const useAutoLimit = create<AutoLimitState>((set) => ({
  override: {},
  setAutoLimit: (tabId, on) => set((s) => ({ override: { ...s.override, [tabId]: on } })),
}));

/** Effective Auto LIMIT of a tab: its override, else the default from the settings. */
export function autoLimitOn(tabId: string): boolean {
  return useAutoLimit.getState().override[tabId] ?? useSettings.getState().settings.autoLimitDefault;
}

/** React hook form of `autoLimitOn`. */
export function useAutoLimitOn(tabId: string): boolean {
  const override = useAutoLimit((s) => s.override[tabId]);
  const byDefault = useSettings((s) => s.settings.autoLimitDefault);
  return override ?? byDefault;
}

/**
 * The texts a run of `stmts` sends: with `LIMIT <settings.autoLimitValue>` appended to the
 * SELECTs when the tab's Auto LIMIT is on. Computed once per run attempt; a confirmation
 * shows and resends this exact array (Ruling R10: what is shown is what runs).
 */
export function autoLimitTexts(tabId: string, stmts: { text: string }[], dialect: Dialect): string[] {
  if (!autoLimitOn(tabId)) return stmts.map((s) => s.text);
  const rows = useSettings.getState().settings.autoLimitValue;
  return stmts.map((s) => applyAutoLimit(s.text, dialect, rows));
}

// Forget closed tabs.
useWorkspaces.subscribe((state) => {
  const override = useAutoLimit.getState().override;
  const ids = Object.keys(override);
  if (ids.length === 0) return;
  const open = new Set(state.workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
  if (ids.some((id) => !open.has(id))) {
    useAutoLimit.setState({ override: Object.fromEntries(Object.entries(override).filter(([id]) => open.has(id))) });
  }
});
