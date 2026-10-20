import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuEntry {
  label: string;
  /** Accessible name when the label alone is not enough (under a heading). */
  ariaLabel?: string;
  run: () => void;
  /** Shown under the heading before it. */
  indent?: boolean;
}
export type MenuItem = MenuEntry | { heading: string };

const isEntry = (i: MenuItem): i is MenuEntry => "run" in i;

/** Where a menu opens: the pointer, or under the focused row for the keyboard. */
export interface MenuAnchor {
  x: number;
  y: number;
}

/** The anchor of a context menu opened from the keyboard (ContextMenu key, Shift+F10). */
export function keyboardMenuAnchor(e: KeyboardEvent<HTMLElement>): MenuAnchor | null {
  if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return null;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}

/**
 * A small context menu of the sidebar: focus on the first item, arrows (wrapping), Home /
 * End, Escape and any press outside close it; it stays inside the window.
 */
export function ContextMenu({
  label,
  anchor,
  items,
  onClose,
}: {
  label: string;
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Keep the whole menu in the window (measured once it is laid out).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(0, Math.min(anchor.x, window.innerWidth - width - 4)),
      y: Math.max(0, Math.min(anchor.y, window.innerHeight - height - 4)),
    });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") els[(i + 1) % els.length]?.focus();
    else if (e.key === "ArrowUp") els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === "Home") els[0]?.focus();
    else if (e.key === "End") els[els.length - 1]?.focus();
    else if (e.key === "Tab") onClose();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 flex min-w-48 flex-col rounded-lg border border-pill-border bg-pill py-1 text-text shadow-lg"
    >
      {items.map((item) =>
        isEntry(item) ? (
          <button
            key={item.ariaLabel ?? item.label}
            type="button"
            role="menuitem"
            aria-label={item.ariaLabel}
            onClick={() => {
              onClose();
              item.run();
            }}
            className={`mx-1 rounded-md py-1 text-left outline-none hover:bg-accent hover:text-accent-contrast focus-visible:bg-accent focus-visible:text-accent-contrast ${item.indent ? "pr-3 pl-6" : "px-3"}`}
          >
            {item.label}
          </button>
        ) : (
          <div key={`h:${item.heading}`} role="presentation" className="px-3 pt-1.5 pb-0.5 text-xs text-text-2">
            {item.heading}
          </div>
        ),
      )}
    </div>
  );
}
