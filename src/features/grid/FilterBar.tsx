import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  formatQuickFilter,
  isQuickFilterRepresentable,
  parseQuickFilter,
  quickFilterColumn,
} from "../../lib/quickFilter";
import { strings } from "../../lib/strings";
import type { Dialect, Filter } from "../../lib/types";
import { FilterBuilder } from "./FilterBuilder";

interface Props {
  dialect: Dialect;
  columns: string[];
  /** The applied filters (the view's): the bar and the builder show them. */
  filters: Filter[];
  /** False when the filters were not applied (changes pending): what was typed stays. */
  onApply: (filters: Filter[]) => boolean;
  /**
   * "Filter with column" (grid header menu): each new `seq` starts a condition on `column`
   * in the field (`column = `) and focuses it.
   */
  start?: { column: string; seq: number } | null;
}

const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 aria-expanded:bg-surface-2";

/**
 * The quick filter field (Enter applies, Escape cancels, errors under the field) and the
 * "Filters (N)" button that opens the builder. Both follow the applied filters.
 */
export function FilterBar({ dialect, columns, filters, onApply, start = null }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const applied = formatQuickFilter(filters);
  const appliedKey = JSON.stringify(filters);
  const [seen, setSeen] = useState(appliedKey);
  const [text, setText] = useState(applied);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (seen !== appliedKey) {
    setSeen(appliedKey);
    setText(applied);
    setError(null);
  }

  const startSeq = start?.seq;
  useEffect(() => {
    if (!start) return;
    const text = `${quickFilterColumn(start.column)} = `;
    setText(text);
    setError(null);
    const el = inputRef.current;
    el?.focus();
    el?.setSelectionRange(text.length, text.length);
    // Only a new request starts a condition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSeq]);

  const applyQuick = () => {
    // Unchanged text (maybe an unparseable raw condition) changes nothing.
    if (text === applied) return setError(null);
    const r = parseQuickFilter(text, columns);
    setError(r.error);
    if (r.error === null && onApply(r.filters)) setText(formatQuickFilter(r.filters));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyQuick();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText(applied);
      setError(null);
    }
  };

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 bg-surface px-3 py-1 text-sm">
        <input
          ref={inputRef}
          aria-label={strings.filters.quickLabel}
          placeholder={strings.filters.quickPlaceholder}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 py-0.5 font-mono focus:outline-none focus:ring-1 focus:ring-accent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {!isQuickFilterRepresentable(filters) && (
          <span
            title={strings.filters.advancedHint}
            className="rounded-sm border border-border px-1.5 text-xs text-muted"
          >
            {strings.filters.advanced}
          </span>
        )}
        <button type="button" className={btn} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {strings.filters.button(filters.length)}
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 pb-1 text-sm text-danger">
          {error}
        </p>
      )}
      {open && (
        <FilterBuilder
          dialect={dialect}
          columns={columns}
          filters={filters}
          onApply={onApply}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
