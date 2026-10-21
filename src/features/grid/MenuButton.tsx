import { Check } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ariaShortcut, formatShortcut } from "../../lib/platform";
import { tip } from "../../lib/tooltip";

export interface MenuEntry {
  /** The item's text. */
  label: string;
  /** Its accessible name when the text alone is not enough. */
  ariaLabel?: string;
  /** A shortcut spec, shown on the right and announced. */
  shortcut?: string;
  /** Set on every item of a radio menu (one choice among several): the current one is true. */
  checked?: boolean;
  onSelect: () => void;
}

interface Props {
  /** The button's accessible name. */
  label: string;
  title?: string;
  menuLabel: string;
  className: string;
  children: ReactNode;
  /** The items, or a function giving them when the menu opens (they may depend on the focus). */
  items: MenuEntry[] | (() => MenuEntry[]);
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end";
  /** True closes an open menu (its container was hidden). */
  closed?: boolean;
  /** The button cannot be pressed (an open menu closes). */
  disabled?: boolean;
}

const itemClass =
  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left whitespace-nowrap outline-none hover:bg-seg-sel focus-visible:bg-seg-sel focus-visible:focus-ring-inset";

/**
 * A button that opens a menu below it (WAI-ARIA menu button): the focus moves to the checked
 * or first item; ↑ / ↓ (wrapping), Home and End move it; Enter or Space chooses; Escape
 * closes and gives the focus back to the button; Tab or a press outside closes it. A choice
 * gives the focus back to the button before it acts, so an action that moves the focus wins.
 */
export function MenuButton({
  label,
  title,
  menuLabel,
  className,
  children,
  items,
  align = "start",
  closed = false,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  if ((closed || disabled) && open) setOpen(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const el = menu.current;
    (el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>("[role^='menuitem']"))?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === "Escape") {
      // Not the filter bar's Escape (it would hide the bar): the menu's.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" && plain) {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowUp" && plain) {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "Home" && plain) {
      e.preventDefault();
      go(0);
    } else if (e.key === "End" && plain) {
      e.preventDefault();
      go(list.length - 1);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        {...tip(title)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={className}
      >
        {children}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={onKeyDown}
          className={`absolute top-full z-40 mt-1 min-w-48 rounded-lg border border-pill-border bg-content p-1 text-sm text-text shadow-lg ${align === "end" ? "right-0" : "left-0"}`}
        >
          {(typeof items === "function" ? items() : items).map((item) => (
            <button
              key={item.ariaLabel ?? item.label}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              // The name without the shortcut text (announced by aria-keyshortcuts).
              aria-label={item.ariaLabel ?? item.label}
              aria-keyshortcuts={item.shortcut ? ariaShortcut(item.shortcut) : undefined}
              tabIndex={-1}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className={itemClass}
            >
              {item.checked !== undefined && (
                <Check aria-hidden size={14} className={item.checked ? "shrink-0" : "invisible shrink-0"} />
              )}
              <span className="flex-1">{item.label}</span>
              {item.shortcut && <span aria-hidden="true">{formatShortcut(item.shortcut)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
