import { type KeyboardEvent, type ReactNode, useId } from "react";
import { useAction } from "../../lib/keymap";
import { strings } from "../../lib/strings";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  type SidebarSegment,
  segmentOf,
  showSidebarSegment,
  useSidebar,
} from "../../stores/sidebar";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { HistoryPanel } from "../editor/HistoryPanel";
import { SavedQueries } from "../editor/SavedQueries";
import { ObjectSidebar } from "../workspace/ObjectSidebar";
import { ResizeEdge } from "../chrome/ResizeEdge";
import { SidebarFooter } from "./SidebarFooter";

const S = strings.sidebar;
const SEGMENTS: SidebarSegment[] = ["items", "queries", "history"];

/**
 * The sidebar's shortcuts, bound by the workspace view whether the sidebar is shown or not:
 * Ctrl+0 shows / hides it, Ctrl+Shift+F searches it, Ctrl+Shift+H opens its History. Off
 * while the workspace is not connected (it has no sidebar then).
 */
export function useSidebarShortcuts(wsId: string, connected: boolean) {
  const opts = { enabled: connected };
  useAction("sidebar.toggle", () => useWorkspaces.getState().toggleSidebar(), opts);
  useAction(
    "sidebar.search",
    () => {
      if (!useWorkspaces.getState().sidebarVisible) useWorkspaces.getState().toggleSidebar();
      useSidebar.getState().requestSearchFocus();
    },
    opts,
  );
  useAction("history.toggle", () => showSidebarSegment(wsId, "history"), opts);
}

/**
 * The workspace's sidebar (spec §2.3): the Items / Queries / History segmented control
 * (remembered per workspace), the tab's search and list, the footer; resizable from its
 * right edge (min 240 px, width remembered).
 */
export function Sidebar({ workspace }: { workspace: Workspace }) {
  const segment = useSidebar((s) => segmentOf(s.segments, workspace.id));
  const setSegment = useSidebar((s) => s.setSegment);
  const domId = useId();
  const tabId = (s: SidebarSegment) => `${domId}-${s}`;
  const panelId = `${domId}-panel`;

  // Tablist keys (automatic activation): ← / → wrap, Home / End; the focus follows.
  const onKeyDown = (e: KeyboardEvent) => {
    const i = SEGMENTS.indexOf(segment);
    const next =
      e.key === "ArrowRight"
        ? SEGMENTS[(i + 1) % SEGMENTS.length]
        : e.key === "ArrowLeft"
          ? SEGMENTS[(i - 1 + SEGMENTS.length) % SEGMENTS.length]
          : e.key === "Home"
            ? SEGMENTS[0]
            : e.key === "End"
              ? SEGMENTS[SEGMENTS.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    setSegment(workspace.id, next);
    document.getElementById(tabId(next))?.focus();
  };

  // The width lives in SidebarFrame only: a resize drag re-renders the frame, not the tree
  // and lists passed to it (same elements, so React skips them).
  return (
    <SidebarFrame>
      <div className="flex h-10 shrink-0 items-center px-2.5">
        <div
          role="tablist"
          aria-label={S.segments.label}
          className="flex h-7 w-full items-center rounded-md border border-pill-border bg-search p-0.5"
        >
          {SEGMENTS.map((s) => (
            <button
              key={s}
              id={tabId(s)}
              type="button"
              role="tab"
              aria-selected={segment === s}
              aria-controls={segment === s ? panelId : undefined}
              tabIndex={segment === s ? 0 : -1}
              onClick={() => setSegment(workspace.id, s)}
              onKeyDown={onKeyDown}
              className="h-full min-w-0 flex-1 truncate rounded-[5px] text-sm text-text-2 outline-none hover:text-text aria-selected:bg-seg-sel aria-selected:font-medium aria-selected:text-text focus-visible:focus-ring-inset"
            >
              {S.segments[s]}
            </button>
          ))}
        </div>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(segment)} className="flex min-h-0 flex-1 flex-col">
        {segment === "items" && <ObjectSidebar workspace={workspace} />}
        {segment === "queries" && <SavedQueries workspace={workspace} />}
        {segment === "history" && <HistoryPanel workspace={workspace} />}
      </div>
      <SidebarFooter workspace={workspace} />
    </SidebarFrame>
  );
}

function SidebarFrame({ children }: { children: ReactNode }) {
  const width = useSidebar((s) => s.width);
  return (
    <aside
      aria-label={S.label}
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-sep bg-side text-text"
    >
      {children}
      <ResizeHandle width={width} />
    </aside>
  );
}

/** The sidebar's right edge: drag it, or use the arrow keys once focused. */
function ResizeHandle({ width }: { width: number }) {
  const setWidth = useSidebar((s) => s.setWidth);
  const saveWidth = useSidebar((s) => s.saveWidth);
  return (
    <ResizeEdge
      side="right"
      width={width}
      min={SIDEBAR_MIN}
      max={SIDEBAR_MAX}
      label={S.resize}
      setWidth={setWidth}
      saveWidth={saveWidth}
    />
  );
}
