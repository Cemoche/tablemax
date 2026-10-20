import { create } from "zustand";
import { useWorkspaces } from "./workspaces";

/** What the sidebar shows (spec §2.3: the Items / Queries / History segmented control). */
export type SidebarSegment = "items" | "queries" | "history";
/** How the Items search matches a name. */
export type MatchMode = "contains" | "startsWith" | "endsWith";

/** Spec §5.2: 262 px by default, never under 240. */
export const SIDEBAR_DEFAULT = 262;
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 640;
/** The width is a per-machine convenience, like the collapsed connection groups. */
export const SIDEBAR_WIDTH_KEY = "tablemax.sidebarWidth";

export const clampSidebarWidth = (px: number) =>
  Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));

/** The width saved by the last session, or the default. */
export function loadSidebarWidth(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

interface SidebarState {
  /** Workspace id -> shown segment (Items when absent). */
  segments: Record<string, SidebarSegment>;
  setSegment: (wsId: string, segment: SidebarSegment) => void;
  width: number;
  /** Clamps, applies and saves. */
  setWidth: (px: number) => void;
  /** Items search options (one set for the whole app). */
  match: MatchMode;
  showTables: boolean;
  showViews: boolean;
  setSearchOptions: (patch: Partial<Pick<SidebarState, "match" | "showTables" | "showViews">>) => void;
  /**
   * Set by `sidebar.search` (Ctrl+Shift+F): the search box of the shown segment takes the
   * focus and clears it, also when it mounts after the request (sidebar hidden before).
   */
  focusSearch: boolean;
  requestSearchFocus: () => void;
}

export const useSidebar = create<SidebarState>((set) => ({
  segments: {},
  setSegment: (wsId, segment) => set((s) => ({ segments: { ...s.segments, [wsId]: segment } })),
  width: loadSidebarWidth(),
  setWidth: (px) => {
    const width = clampSidebarWidth(px);
    set({ width });
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      // Storage unavailable: the width only lasts for this session.
    }
  },
  match: "contains",
  showTables: true,
  showViews: true,
  setSearchOptions: (patch) => set(patch),
  focusSearch: false,
  requestSearchFocus: () => set({ focusSearch: true }),
}));

export const segmentOf = (segments: Record<string, SidebarSegment>, wsId: string): SidebarSegment =>
  segments[wsId] ?? "items";

/** Shows the sidebar (it is one for every workspace) on `segment` for workspace `wsId`. */
export function showSidebarSegment(wsId: string, segment: SidebarSegment) {
  useSidebar.getState().setSegment(wsId, segment);
  if (!useWorkspaces.getState().sidebarVisible) useWorkspaces.getState().toggleSidebar();
}
