import type { MouseEvent } from "react";
import * as ipc from "../../lib/ipc";
import type { ResizeDirection } from "../../lib/types";
import { useSettings } from "../../stores/settings";

/** Edges 4 px thick, corners 10 px square, above everything (dialogs included). */
const HANDLES: { dir: ResizeDirection; className: string }[] = [
  { dir: "North", className: "top-0 left-2.5 right-2.5 h-1 cursor-n-resize" },
  { dir: "South", className: "bottom-0 left-2.5 right-2.5 h-1 cursor-s-resize" },
  { dir: "West", className: "left-0 top-2.5 bottom-2.5 w-1 cursor-w-resize" },
  { dir: "East", className: "right-0 top-2.5 bottom-2.5 w-1 cursor-e-resize" },
  { dir: "NorthWest", className: "top-0 left-0 size-2.5 cursor-nw-resize" },
  { dir: "NorthEast", className: "top-0 right-0 size-2.5 cursor-ne-resize" },
  { dir: "SouthWest", className: "bottom-0 left-0 size-2.5 cursor-sw-resize" },
  { dir: "SouthEast", className: "bottom-0 right-0 size-2.5 cursor-se-resize" },
];

/**
 * Invisible grips along the edges and corners of the frameless window: a press starts a
 * native resize from that side (Rust `window_start_resize`). Not rendered when the window
 * uses the system title bar (it has native borders then).
 */
export function ResizeHandles() {
  const systemTitleBar = useSettings((s) => s.systemTitleBar);
  if (systemTitleBar) return null;
  const start = (dir: ResizeDirection) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void ipc.windowStartResize(dir)?.catch(() => {});
  };
  return (
    <>
      {HANDLES.map((h) => (
        <div key={h.dir} aria-hidden data-resize={h.dir} className={`fixed z-[100] ${h.className}`} onMouseDown={start(h.dir)} />
      ))}
    </>
  );
}
