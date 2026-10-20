import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { effectiveShortcuts } from "../../lib/keymap";
import { matchCombination } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { useGridViews } from "../../stores/gridViews";
import { useSettings } from "../../stores/settings";
import { reconcileLayout } from "./columnLayout";
import { popoverBox, popoverButton, useDismiss } from "./PagePopover";

const c = strings.grid.columnsPopover;

interface Props {
  /** The table's columns (their names). */
  columns: string[];
  /** The table's layout in gridViews (the grid reads the same one). */
  layoutKey: string;
  onClose: (refocus: boolean) => void;
}

/**
 * The columns shown (the keyboard way to hide and show them, Task 5's header menu having
 * none): one checkbox per column in display order, Show all. At least one column stays
 * shown. Not modal: Escape or a press outside closes it.
 */
export function ColumnsPopover({ columns, layoutKey, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastId = useId();
  const stored = useGridViews((s) => s.layouts[layoutKey]);
  const layout = reconcileLayout(stored, columns);
  const shown = layout.order.filter((n) => !layout.hidden.includes(n));
  const keymap = useSettings((st) => st.settings.keymap);
  useDismiss(ref, onClose);
  // The key that opened it closes it too, also from a checkbox (the tab's listener skips fields).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!effectiveShortcuts("grid.columns", keymap).some((spec) => matchCombination(e.nativeEvent, spec))) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) onClose(true);
  };
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")?.focus();
  }, []);

  const setHidden = (hidden: string[]) => useGridViews.getState().setLayout(layoutKey, { hidden });
  const toggle = (name: string) =>
    setHidden(layout.hidden.includes(name) ? layout.hidden.filter((h) => h !== name) : [...layout.hidden, name]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={c.label}
      className={`${popoverBox} right-0 flex w-64 flex-col gap-1`}
      onKeyDown={onKeyDown}
    >
      <span id={lastId} hidden>
        {c.lastShown}
      </span>
      <ul className="flex max-h-72 flex-col overflow-y-auto">
        {layout.order.map((name) => {
          const on = shown.includes(name);
          const last = on && shown.length <= 1;
          return (
            <li key={name}>
              <label className="flex h-6 items-center gap-2 rounded-md px-1 hover:bg-seg-sel">
                <input
                  type="checkbox"
                  aria-label={name}
                  aria-describedby={last ? lastId : undefined}
                  checked={on}
                  disabled={last}
                  onChange={() => toggle(name)}
                  className="size-3.5 shrink-0 accent-accent outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <span className="min-w-0 truncate font-mono">{name}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={`${popoverButton} self-end`}
        disabled={layout.hidden.length === 0}
        onClick={() => setHidden([])}
      >
        {c.showAll}
      </button>
    </div>
  );
}
