import { type KeyboardEvent, type PointerEvent, useRef } from "react";

/** Arrow keys on a resize edge move it by this much. */
export const RESIZE_KEY_STEP = 10;

interface Props {
  /**
   * Which edge of the panel it sits on: the sidebar's right edge widens to the right, the
   * row details' left edge to the left (drag and arrow keys alike).
   */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  label: string;
  /** Clamps and applies (called on every move of a drag). */
  setWidth: (px: number) => void;
  /** Saves the width for the next start: once, at the end of a drag or a key press. */
  saveWidth: () => void;
}

/** A panel's resizable edge: drag it, or use the arrow keys once focused. */
export function ResizeEdge({ side, width, min, max, label, setWidth, saveWidth }: Props) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const sign = side === "right" ? 1 : -1;
  const wider = side === "right" ? "ArrowRight" : "ArrowLeft";
  const narrower = side === "right" ? "ArrowLeft" : "ArrowRight";

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, width };
    const move = (ev: globalThis.PointerEvent) => {
      if (drag.current) setWidth(drag.current.width + sign * (ev.clientX - drag.current.x));
    };
    const up = () => {
      drag.current = null;
      saveWidth();
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
    if (e.key === wider) setWidth(width + RESIZE_KEY_STEP);
    else if (e.key === narrower) setWidth(width - RESIZE_KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") saveWidth();
      }}
      className={`absolute inset-y-0 ${side === "right" ? "-right-1" : "-left-1"} z-10 w-2 cursor-col-resize outline-none hover:bg-accent/30 focus-visible:bg-accent/50`}
    />
  );
}
