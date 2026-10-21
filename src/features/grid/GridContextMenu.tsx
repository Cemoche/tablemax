import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ariaShortcut, formatShortcut } from "../../lib/platform";
import { type MenuCloseReason, restoreFocusOnClose } from "../sidebar/ContextMenu";

export interface MenuEntry {
  /** What the entry shows. */
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Accessible name when the label alone is not enough (under a heading). */
  ariaLabel?: string;
  /** Shown under the heading before it. */
  indent?: boolean;
  /** The canonical spec of the keys that do the same (shown on the right). */
  shortcut?: string;
}

export type MenuItem = MenuEntry | { heading: string } | "separator";

const isEntry = (i: MenuItem): i is MenuEntry => typeof i === "object" && "onSelect" in i;

/** The non-empty groups, one separator between two groups. */
export function joinMenuGroups(groups: MenuItem[][]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    if (out.length > 0) out.push("separator");
    out.push(...g);
  }
  return out;
}

interface Props {
  /** Viewport position of the click. */
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose: (reason: MenuCloseReason) => void;
}

/**
 * The grid's popover menu (Glide has none): focus on the first entry, arrows (wrapping),
 * Home / End, Escape, Tab or a press outside close it; it stays inside the window and gives
 * the focus back to what had it (the grid) after Escape or an entry.
 */
export function GridContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** What had the focus when the menu opened (the grid's canvas). */
  const opener = useRef<Element | null>(null);
  if (opener.current === null) opener.current = document.activeElement;

  const close = (reason: MenuCloseReason) => {
    closeRef.current(reason);
    const el = opener.current;
    restoreFocusOnClose(reason, () => {
      if (el instanceof HTMLElement && el.isConnected && el !== document.body) el.focus();
    });
  };
  const closeOn = useRef(close);
  closeOn.current = close;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(0, Math.min(x, window.innerWidth - width - 4)),
      y: Math.max(0, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeOn.current("escape");
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeOn.current("outside");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") els[(i + 1) % els.length]?.focus();
    else if (e.key === "ArrowUp") els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === "Home") els[0]?.focus();
    else if (e.key === "End") els[els.length - 1]?.focus();
    else if (e.key === "Tab") close("tab");
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
      className="fixed z-50 flex max-h-[calc(100vh-8px)] min-w-52 flex-col overflow-y-auto rounded-lg border border-pill-border bg-pill py-1 text-text shadow-lg"
    >
      {items.map((item, i) => {
        if (item === "separator") {
          return <div key={`sep-${i}`} role="separator" className="mx-2 my-1 border-t border-pill-border" />;
        }
        if (!isEntry(item)) {
          return (
            <div key={`h-${i}`} role="presentation" className="px-3 pt-1.5 pb-0.5 text-xs text-text-2">
              {item.heading}
            </div>
          );
        }
        return (
          <button
            key={`${i}\u0000${item.ariaLabel ?? item.label}`}
            type="button"
            role="menuitem"
            // With a shortcut hint, the name stays the label alone (the hint is aria-keyshortcuts).
            aria-label={item.ariaLabel ?? (item.shortcut ? item.label : undefined)}
            aria-keyshortcuts={item.shortcut ? ariaShortcut(item.shortcut) : undefined}
            disabled={item.disabled}
            onClick={() => {
              close("item");
              item.onSelect();
            }}
            className={`group mx-1 flex items-center gap-4 rounded-md py-1 text-left outline-none hover:bg-accent-strong hover:text-accent-contrast focus-visible:bg-accent-strong focus-visible:text-accent-contrast disabled:text-text-2 disabled:hover:bg-transparent ${item.indent ? "pr-3 pl-6" : "px-3"}`}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              // 70 % at rest; opaque on the highlighted row (white at 70 % on --accent-strong: ≈3.5:1, #107).
              <span
                aria-hidden="true"
                className="shrink-0 text-xs opacity-70 group-enabled:group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                {formatShortcut(item.shortcut)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
