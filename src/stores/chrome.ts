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
}

const bump = (m: Record<string, number>, id: string) => ({ ...m, [id]: (m[id] ?? 0) + 1 });

export const useChrome = create<ChromeState>((set) => ({
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
