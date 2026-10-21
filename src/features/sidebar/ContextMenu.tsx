import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

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

/** Why a menu closed. */
export type MenuCloseReason = "escape" | "item" | "tab" | "outside";

/**
 * Gives the focus back to the menu's trigger: after Escape or an item; after a press
 * outside only if nothing took the focus (the SQL editor and the grid focus themselves on
 * mousedown, before the menu's document listener runs; a plain field takes it after the
 * event), checked once the press is over. Tab lets the focus move on.
 */
export function restoreFocusOnClose(reason: MenuCloseReason, restore: () => void): void {
  if (reason === "escape" || reason === "item") {
    restore();
    return;
  }
  if (reason !== "outside") return;
  setTimeout(() => {
    const active = document.activeElement;
    if (!active || active === document.body) restore();
  }, 0);
}

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
 * Menu keys shared by the sidebar's menus: ↓ / ↑ move the focus through `items`, wrapping,
 * Home / End go to the ends. True when the key was one of them (the caller prevents it).
 */
export function moveMenuFocus(key: string, items: HTMLElement[]): boolean {
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (key === "ArrowDown") items[(i + 1) % items.length]?.focus();
  else if (key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
  else if (key === "Home") items[0]?.focus();
  else if (key === "End") items[items.length - 1]?.focus();
  else return false;
  return true;
}

/**
 * A small context menu of the sidebar: focus on the first item, arrows (wrapping), Home /
 * End, Escape and any press outside close it; it stays inside the window. A press on
 * `trigger` (the button that opened it, which toggles it itself) does not count as outside.
 */
export function ContextMenu({
  label,
  anchor,
  items,
  onClose,
  trigger,
}: {
  label: string;
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: (reason: MenuCloseReason) => void;
  trigger?: RefObject<HTMLElement | null>;
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
      if (e.key === "Escape") closeRef.current("escape");
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || trigger?.current?.contains(target)) return;
      closeRef.current("outside");
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []); // `trigger` is a ref, read at press time

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (moveMenuFocus(e.key, els)) e.preventDefault();
    else if (e.key === "Tab") {
      e.preventDefault();
      onClose("tab");
    }
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
              onClose("item");
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
