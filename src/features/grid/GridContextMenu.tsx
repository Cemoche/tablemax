import { useEffect, useRef } from "react";

export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean } | "separator";

interface Props {
  /** Viewport position of the click. */
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose: () => void;
}

/** A small popover menu (Glide has no context menu): Escape or a click outside closes it. */
export function GridContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: x, top: y }}
      className="fixed z-20 min-w-44 rounded-md border border-border bg-surface py-1 shadow-lg"
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={`sep-${i}`} role="separator" className="my-1 border-t border-border" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className="block w-full px-3 py-1 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:text-muted disabled:hover:bg-transparent"
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
