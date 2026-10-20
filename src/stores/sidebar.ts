import { create } from "zustand";
import { persistedWidth } from "../lib/persistedWidth";
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

const width = persistedWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX);
export const clampSidebarWidth = width.clamp;
/** The width saved by the last session, or the default. */
export const loadSidebarWidth = width.load;

interface SidebarState {
  /** Workspace id -> shown segment (Items when absent). */
  segments: Record<string, SidebarSegment>;
  setSegment: (wsId: string, segment: SidebarSegment) => void;
  width: number;
  /** Clamps and applies (a drag calls it on every move). */
  setWidth: (px: number) => void;
  /** Saves the width for the next start (once, at the end of a drag or a key press). */
  saveWidth: () => void;
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

export const useSidebar = create<SidebarState>((set, get) => ({
  segments: {},
  setSegment: (wsId, segment) => set((s) => ({ segments: { ...s.segments, [wsId]: segment } })),
  width: loadSidebarWidth(),
  setWidth: (px) => set({ width: clampSidebarWidth(px) }),
  saveWidth: () => width.save(get().width),
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
