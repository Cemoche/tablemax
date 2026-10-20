import { type KeyboardEvent, type PointerEvent, useRef } from "react";
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
import { SidebarFooter } from "./SidebarFooter";

const S = strings.sidebar;
const SEGMENTS: SidebarSegment[] = ["items", "queries", "history"];
/** Arrow keys on the resize handle move it by this much. */
const KEY_STEP = 10;

/**
 * The sidebar's shortcuts, bound by the workspace view whether the sidebar is shown or not:
 * Ctrl+0 shows / hides it, Ctrl+Shift+F searches it, Ctrl+Shift+H opens its History.
 */
export function useSidebarShortcuts(wsId: string) {
  useAction("sidebar.toggle", () => useWorkspaces.getState().toggleSidebar());
  useAction("sidebar.search", () => {
    if (!useWorkspaces.getState().sidebarVisible) useWorkspaces.getState().toggleSidebar();
    useSidebar.getState().requestSearchFocus();
  });
  useAction("history.toggle", () => showSidebarSegment(wsId, "history"));
}

/**
 * The workspace's sidebar (spec §2.3): the Items / Queries / History segmented control
 * (remembered per workspace), the tab's search and list, the footer; resizable from its
 * right edge (min 240 px, width remembered).
 */
export function Sidebar({ workspace }: { workspace: Workspace }) {
  const segment = useSidebar((s) => segmentOf(s.segments, workspace.id));
  const setSegment = useSidebar((s) => s.setSegment);
  const width = useSidebar((s) => s.width);

  return (
    <aside
      aria-label={S.label}
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-sep bg-side text-text"
    >
      <div className="flex h-10 shrink-0 items-center px-2.5">
        <div
          role="group"
          aria-label={S.segments.label}
          className="flex h-7 w-full items-center rounded-md border border-pill-border bg-search p-0.5"
        >
          {SEGMENTS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={segment === s}
              onClick={() => setSegment(workspace.id, s)}
              className="h-full min-w-0 flex-1 truncate rounded-[5px] text-sm text-text-2 outline-none hover:text-text aria-pressed:bg-seg-sel aria-pressed:font-medium aria-pressed:text-text focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              {S.segments[s]}
            </button>
          ))}
        </div>
      </div>
      {segment === "items" && <ObjectSidebar workspace={workspace} />}
      {segment === "queries" && <SavedQueries workspace={workspace} />}
      {segment === "history" && <HistoryPanel workspace={workspace} />}
      <SidebarFooter workspace={workspace} />
      <ResizeHandle width={width} />
    </aside>
  );
}

/** The sidebar's right edge: drag it, or use the arrow keys once focused. */
function ResizeHandle({ width }: { width: number }) {
  const setWidth = useSidebar((s) => s.setWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, width };
    const move = (ev: globalThis.PointerEvent) => {
      if (drag.current) setWidth(drag.current.width + ev.clientX - drag.current.x);
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.removeProperty("cursor");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.body.style.cursor = "col-resize";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setWidth(width - KEY_STEP);
    else if (e.key === "ArrowRight") setWidth(width + KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-label={S.resize}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none hover:bg-accent/30 focus-visible:bg-accent/50"
    />
  );
}
