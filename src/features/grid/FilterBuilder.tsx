import { type KeyboardEvent, useState } from "react";
import { strings } from "../../lib/strings";
import type { Dialect, Filter, FilterOp } from "../../lib/types";
import {
  ANY_COLUMN,
  arityOf,
  type DraftColumn,
  draftsFromFilters,
  type FilterDraft,
  filtersFromDrafts,
  newDraft,
  opsFor,
  RAW_SQL,
  withColumn,
  withOp,
} from "./filterDrafts";

interface Props {
  dialect: Dialect;
  columns: string[];
  /** The applied filters: the rows follow them whenever they change. */
  filters: Filter[];
  /** False when the filters were not applied (changes pending): the rows stay as typed. */
  onApply: (filters: Filter[]) => boolean;
  onClose: () => void;
}

const field =
  "min-w-0 rounded-sm border border-border bg-bg px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent";
const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

/** The applied filters as rows, else one blank row (ignored until it is touched). */
const initialDrafts = (filters: Filter[], columns: string[]) =>
  filters.length > 0 ? draftsFromFilters(filters) : [newDraft(columns)];
const blankIds = (filters: Filter[], drafts: FilterDraft[]) =>
  new Set(filters.length > 0 ? [] : drafts.map((d) => d.id));

// <select> values: column names are free text, so the two special choices cannot collide.
const columnValue = (c: DraftColumn) => (c === ANY_COLUMN ? "any" : c === RAW_SQL ? "raw" : `c:${c}`);
const columnFromValue = (v: string): DraftColumn =>
  v === "any" ? ANY_COLUMN : v === "raw" ? RAW_SQL : v.slice(2);

/** Rows `[column | Any column | Raw SQL] [operator] [value(s)]`, with + / –, Apply and Clear. */
export function FilterBuilder({ dialect, columns, filters, onApply, onClose }: Props) {
  const appliedKey = JSON.stringify(filters);
  const [seen, setSeen] = useState(appliedKey);
  const [drafts, setDrafts] = useState(() => initialDrafts(filters, columns));
  /** Rows added blank and never touched: Apply leaves them out (no `col = ''` by accident). */
  const [blank, setBlank] = useState(() => blankIds(filters, drafts));
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (seen !== appliedKey) {
    const next = initialDrafts(filters, columns);
    setSeen(appliedKey);
    setDrafts(next);
    setBlank(blankIds(filters, next));
    setErrors({});
  }

  const update = (id: string, fn: (d: FilterDraft) => FilterDraft) => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? fn(d) : d)));
    setBlank((b) => {
      if (!b.has(id)) return b;
      const next = new Set(b);
      next.delete(id);
      return next;
    });
    setErrors((es) => {
      if (!(id in es)) return es;
      const next = { ...es };
      delete next[id];
      return next;
    });
  };

  const apply = () => {
    const r = filtersFromDrafts(drafts.filter((d) => !blank.has(d.id)));
    setErrors(r.errors);
    if (Object.keys(r.errors).length === 0) onApply(r.filters);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      apply();
    }
  };

  return (
    <div
      role="group"
      aria-label={strings.filters.builderLabel}
      className="flex flex-col gap-1 border-b border-border bg-surface px-3 py-2 text-sm"
      onKeyDown={onKeyDown}
    >
      {drafts.map((d, i) => {
        const row = i + 1;
        const ops = opsFor(dialect, d.column);
        // An operator the dialect does not offer (typed in the quick bar) stays selectable.
        const opChoices = ops.includes(d.op) ? ops : [...ops, d.op];
        const columnChoices =
          typeof d.column === "string" && !columns.includes(d.column) ? [...columns, d.column] : columns;
        const arity = arityOf(d.op);
        const setValue = (k: number, v: string) =>
          update(d.id, (x) => ({ ...x, values: x.values.map((old, j) => (j === k ? v : old)) }));
        return (
          <div key={d.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <select
                aria-label={strings.filters.columnLabel(row)}
                className={`${field} w-44`}
                value={columnValue(d.column)}
                onChange={(e) => update(d.id, (x) => withColumn(x, columnFromValue(e.target.value)))}
              >
                <option value="any">{strings.filters.anyColumn}</option>
                <option value="raw">{strings.filters.rawSql}</option>
                {columnChoices.map((c) => (
                  <option key={c} value={columnValue(c)}>
                    {c}
                  </option>
                ))}
              </select>
              {d.column !== RAW_SQL && (
                <select
                  aria-label={strings.filters.opLabel(row)}
                  className={`${field} w-32`}
                  value={d.op}
                  onChange={(e) => update(d.id, (x) => withOp(x, e.target.value as FilterOp))}
                >
                  {opChoices.map((o) => (
                    <option key={o} value={o}>
                      {strings.filters.ops[o]}
                    </option>
                  ))}
                </select>
              )}
              {d.column === RAW_SQL ? (
                <input
                  aria-label={strings.filters.rawLabel(row)}
                  placeholder={strings.filters.rawPlaceholder}
                  className={`${field} flex-1 font-mono`}
                  value={d.values[0] ?? ""}
                  onChange={(e) => setValue(0, e.target.value)}
                />
              ) : arity === "list" ? (
                <input
                  aria-label={strings.filters.listLabel(row)}
                  placeholder={strings.filters.listPlaceholder}
                  className={`${field} flex-1`}
                  value={d.list}
                  onChange={(e) => update(d.id, (x) => ({ ...x, list: e.target.value }))}
                />
              ) : arity === 0 ? (
                <span className="flex-1" />
              ) : (
                <>
                  <input
                    aria-label={strings.filters.valueLabel(row)}
                    className={`${field} flex-1`}
                    value={d.values[0] ?? ""}
                    onChange={(e) => setValue(0, e.target.value)}
                  />
                  {arity === 2 && (
                    <>
                      <span className="text-muted">{strings.filters.and}</span>
                      <input
                        aria-label={strings.filters.secondValueLabel(row)}
                        className={`${field} flex-1`}
                        value={d.values[1] ?? ""}
                        onChange={(e) => setValue(1, e.target.value)}
                      />
                    </>
                  )}
                </>
              )}
              <button
                type="button"
                className={btn}
                aria-label={strings.filters.removeRow(row)}
                onClick={() => setDrafts((ds) => ds.filter((x) => x.id !== d.id))}
              >
                {strings.filters.removeRowText}
              </button>
            </div>
            {errors[d.id] && (
              <p role="alert" className="text-danger">
                {errors[d.id]}
              </p>
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className={btn}
          onClick={() => {
            const d = newDraft(columns);
            setDrafts((ds) => [...ds, d]);
            setBlank((b) => new Set(b).add(d.id));
          }}
        >
          {strings.filters.addRow}
        </button>
        <span className="flex-1" />
        <button type="button" className={btn} onClick={() => onApply([])}>
          {strings.filters.clear}
        </button>
        <button type="button" className={btn} onClick={apply}>
          {strings.filters.apply}
        </button>
      </div>
    </div>
  );
}
