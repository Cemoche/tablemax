import { type FocusEvent, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type KeymapActionId, effectiveShortcut, effectiveShortcuts } from "../../lib/keymap";
import { ariaShortcut, formatShortcut } from "../../lib/platform";
import { readRawCondition } from "../../lib/quickFilter";
import { matchCombination } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import type { Dialect, Filter, FilterCombine, FilterOp } from "../../lib/types";
import { useSettings } from "../../stores/settings";
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
  /** The bar's element id (the Filters button controls it). */
  id: string;
  dialect: Dialect;
  columns: string[];
  /** The applied filters (the view's) and how they are joined: the rows follow them. */
  filters: Filter[];
  combine: FilterCombine;
  /** False when the filters were not applied (changes pending): the rows stay as typed. */
  onApply: (filters: Filter[], combine: FilterCombine) => boolean;
  /** Escape on an empty bar, or the Filters key (Ctrl+F) inside it. */
  onClose: () => void;
  /** Each new value above 0 puts the focus on the first row (the bar was opened from the keyboard or its button). */
  focusSeq: number;
  /** "Filter with column" (grid header menu): each new `seq` starts a row on `column` and focuses its value. */
  start?: { column: string; seq: number } | null;
}

const f = strings.filters;
const field =
  "h-6 min-w-0 rounded-md border border-pill-border bg-search px-1.5 text-sm text-text outline-none placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-1 focus-visible:outline-accent";
const button =
  "flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border border-pill-border bg-btn px-2 text-sm text-text outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-contrast";

// <select> values: column names are free text, so the two special choices cannot collide.
const columnValue = (c: DraftColumn) => (c === ANY_COLUMN ? "any" : c === RAW_SQL ? "raw" : `c:${c}`);
const columnFromValue = (v: string): DraftColumn =>
  v === "any" ? ANY_COLUMN : v === "raw" ? RAW_SQL : v.slice(2);

const keyOf = (filters: Filter[], combine: FilterCombine) => JSON.stringify([filters, combine]);

interface Rows {
  rows: FilterDraft[];
  /** Rows added blank and never touched: Apply All leaves them out (no `col = ''` by accident). */
  blank: Set<string>;
  /** Rows turned off (their checkbox, Ctrl+B): Apply All leaves them out. */
  off: Set<string>;
  /** The filters each applied row gave when it was applied. */
  applied: Record<string, Filter[]>;
  /** Applied rows changed since: no longer tinted (what is applied is still their old filters). */
  dirty: Set<string>;
}

/** The applied filters as rows (checked, applied), else one blank row. */
function rowsFrom(filters: Filter[], columns: string[]): Rows {
  if (filters.length === 0) {
    const d = newDraft(columns);
    return { rows: [d], blank: new Set([d.id]), off: new Set(), applied: {}, dirty: new Set() };
  }
  const rows = draftsFromFilters(filters);
  const applied = Object.fromEntries(rows.map((r, i) => [r.id, [filters[i]]]));
  return { rows, blank: new Set(), off: new Set(), applied, dirty: new Set() };
}

const without = <T,>(s: Set<T>, v: T) => {
  if (!s.has(v)) return s;
  const n = new Set(s);
  n.delete(v);
  return n;
};

/**
 * The filter bar above the grid (spec §2.3): one row per condition with its checkbox
 * (Ctrl+B), column (Any column, Raw SQL, the columns), operator, value, Apply (Enter: this
 * condition alone), + (Ctrl+I) and − (Ctrl+Shift+I); Apply All joins the checked rows with
 * AND (Ctrl+Enter) or OR (Ctrl+Shift+Enter). Applied rows are tinted. Its keys act only
 * while the focus is in the bar, and never reach the table tab (where Ctrl+I adds a row).
 */
export function FilterBar({ id, dialect, columns, filters, combine, onApply, onClose, focusSeq, start = null }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const keymap = useSettings((s) => s.settings.keymap);
  const [state, setState] = useState(() => rowsFrom(filters, columns));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<FilterCombine>(combine);
  // Applied filters changed elsewhere (a quick filter, a foreign key, a reload of the tab)
  // rebuild the rows; the bar's own apply does not (what was typed and unchecked stays).
  const propsKey = keyOf(filters, combine);
  const [seen, setSeen] = useState(propsKey);
  const own = useRef<string | null>(null);
  if (seen !== propsKey) {
    setSeen(propsKey);
    if (propsKey !== own.current) {
      own.current = null;
      setState(rowsFrom(filters, columns));
      setErrors({});
      setMode(combine);
    }
  }
  const { rows, blank, off, applied, dirty } = state;

  /** Where the focus goes after the next render (a row added, removed or started). */
  const [focusTo, setFocusTo] = useState<{ row: string; field: "column" | "value" } | null>(null);
  useLayoutEffect(() => {
    if (!focusTo) return;
    setFocusTo(null);
    const rowEl = ref.current?.querySelector(`[data-row-id="${focusTo.row}"]`);
    const target =
      (focusTo.field === "value" && rowEl?.querySelector<HTMLElement>('[data-field="value"]')) ||
      rowEl?.querySelector<HTMLElement>('[data-field="column"]');
    target?.focus();
  }, [focusTo]);

  useEffect(() => {
    if (focusSeq <= 0) return;
    ref.current?.querySelector<HTMLElement>('[data-field="column"]')?.focus();
  }, [focusSeq]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const startSeq = start?.seq;
  useEffect(() => {
    if (!start) return;
    const s = stateRef.current;
    const last = s.rows[s.rows.length - 1];
    if (last && s.blank.has(last.id)) {
      // The blank row is reused (as typed by the user, it is no longer blank).
      setState({
        ...s,
        rows: s.rows.map((r) => (r === last ? withColumn(r, start.column) : r)),
        blank: without(s.blank, last.id),
      });
      setFocusTo({ row: last.id, field: "value" });
    } else {
      const d = withColumn(newDraft(columns), start.column);
      setState({ ...s, rows: [...s.rows, d] });
      setFocusTo({ row: d.id, field: "value" });
    }
    // Only a new request starts a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSeq]);

  const update = (rowId: string, fn: (d: FilterDraft) => FilterDraft) => {
    setState((s) => ({
      ...s,
      rows: s.rows.map((d) => (d.id === rowId ? fn(d) : d)),
      blank: without(s.blank, rowId),
      dirty: rowId in s.applied ? new Set(s.dirty).add(rowId) : s.dirty,
    }));
    setErrors((es) => {
      if (!(rowId in es)) return es;
      const next = { ...es };
      delete next[rowId];
      return next;
    });
  };

  /** Applies `chosen` rows joined by `how`; false (and messages) when a row is invalid or the apply is refused. */
  const applyRows = (chosen: FilterDraft[], how: FilterCombine): boolean => {
    const r = filtersFromDrafts(chosen, { columns, combine: how });
    setErrors(r.errors);
    if (Object.keys(r.errors).length > 0) return false;
    own.current = keyOf(r.filters, how);
    if (!onApply(r.filters, how)) {
      own.current = null;
      return false;
    }
    setState((s) => ({ ...s, applied: r.byRow, dirty: new Set() }));
    return true;
  };
  /** One row alone, with AND: the join control follows (it shows how the filters are applied). */
  const applyRow = (rowId: string) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    setMode("and");
    applyRows([row], "and");
  };
  const applyAll = (how: FilterCombine) => {
    setMode(how);
    applyRows(
      rows.filter((r) => !blank.has(r.id) && !off.has(r.id)),
      how,
    );
  };
  const toggle = (rowId: string) => setState((s) => ({ ...s, off: s.off.has(rowId) ? without(s.off, rowId) : new Set(s.off).add(rowId) }));
  const addAfter = (rowId: string) => {
    const d = newDraft(columns);
    setState((s) => {
      const at = s.rows.findIndex((r) => r.id === rowId);
      const next = [...s.rows];
      next.splice(at < 0 ? next.length : at + 1, 0, d);
      return { ...s, rows: next, blank: new Set(s.blank).add(d.id) };
    });
    setFocusTo({ row: d.id, field: "column" });
  };
  const remove = (rowId: string) => {
    const at = rows.findIndex((r) => r.id === rowId);
    if (at < 0) return;
    // An applied row goes with its filters: the other applied rows are applied again.
    if (rowId in applied) {
      const rest = rows.filter((r) => r.id !== rowId && r.id in applied).flatMap((r) => applied[r.id]);
      own.current = keyOf(rest, combine);
      if (!onApply(rest, combine)) {
        own.current = null;
        return;
      }
    }
    const left = rows.filter((r) => r.id !== rowId);
    const fresh = left.length === 0 ? newDraft(columns) : null;
    const nextRows = fresh ? [fresh] : left;
    const restApplied = { ...applied };
    delete restApplied[rowId];
    setState({
      rows: nextRows,
      blank: fresh ? new Set(without(blank, rowId)).add(fresh.id) : without(blank, rowId),
      off: without(off, rowId),
      applied: restApplied,
      dirty: without(dirty, rowId),
    });
    setErrors((es) => {
      const next = { ...es };
      delete next[rowId];
      return next;
    });
    setFocusTo({ row: nextRows[Math.min(at, nextRows.length - 1)].id, field: "column" });
  };

  const isKey = (action: KeymapActionId, e: KeyboardEvent) =>
    effectiveShortcuts(action, keymap).some((spec) => matchCombination(e.nativeEvent, spec));
  const empty = filters.length === 0 && rows.every((r) => blank.has(r.id));

  /** The row that last had the focus (WebKitGTK focuses a clicked button: Apply All, AND / OR). */
  const lastRow = useRef<string | null>(null);
  const rowOf = (target: EventTarget) =>
    target instanceof Element ? target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId : undefined;
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const id = rowOf(e.target);
    if (id) lastRow.current = id;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ownRow = rowOf(e.target);
    // The row keys act on the focused row; from the bar's other controls, on the row focused
    // last (else the only row): Ctrl+B after a click on Apply All toggles a row (#102).
    const remembered = rows.some((r) => r.id === lastRow.current) ? lastRow.current! : undefined;
    const rowId = ownRow ?? remembered ?? (rows.length === 1 ? rows[0].id : undefined);
    const act = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      // A held combination acts once.
      if (!e.repeat) fn();
    };
    if (isKey("filters.toggle", e)) return act(() => rowId && toggle(rowId));
    if (isKey("filters.add", e)) return act(() => addAfter(rowId ?? rows[rows.length - 1].id));
    if (isKey("filters.remove", e)) return act(() => rowId && remove(rowId));
    if (isKey("filters.applyAll", e)) return act(() => applyAll("and"));
    if (isKey("filters.applyAllOr", e)) return act(() => applyAll("or"));
    // The table tab's Filters key closes the bar from inside it.
    if (isKey("grid.filters", e)) return act(onClose);
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (e.key === "Escape" && plain && empty) return act(onClose);
    if (
      e.key === "Enter" &&
      plain &&
      ownRow &&
      e.target instanceof HTMLInputElement &&
      e.target.type === "text"
    ) {
      e.preventDefault();
      applyRow(ownRow);
    }
  };

  const shortcut = (action: KeymapActionId) => effectiveShortcut(action, keymap);
  const hint = (label: string, action: KeymapActionId) => f.withShortcut(label, formatShortcut(shortcut(action)));

  return (
    <div
      id={id}
      ref={ref}
      role="region"
      aria-label={f.barLabel}
      className="flex items-start gap-2 border-b border-sep bg-side px-3 py-1 text-sm text-text"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {rows.map((d, i) => {
          const row = i + 1;
          const isApplied = d.id in applied && !dirty.has(d.id);
          const ops = opsFor(dialect, d.column);
          // An operator the dialect does not offer (from a filter applied elsewhere) stays selectable.
          const opChoices = ops.includes(d.op) ? ops : [...ops, d.op];
          const columnChoices =
            typeof d.column === "string" && !columns.includes(d.column) ? [...columns, d.column] : columns;
          const arity = arityOf(d.op);
          // How a Raw SQL row reads, with the join Apply All would use (shown next to it).
          const rawText = d.column === RAW_SQL ? (d.values[0] ?? "") : "";
          const reading = rawText.trim() === "" ? null : readRawCondition(rawText, columns, mode);
          const readingId = `${uid}-reading-${d.id}`;
          const setValue = (k: number, v: string) =>
            update(d.id, (x) => ({ ...x, values: x.values.map((old, j) => (j === k ? v : old)) }));
          return (
            <div key={d.id} className="flex flex-col">
              <div
                role="group"
                aria-label={f.rowLabel(row, isApplied)}
                data-row-id={d.id}
                data-applied={isApplied ? "true" : undefined}
                className={`-mx-1.5 flex h-[38px] items-center gap-1.5 rounded-md px-1.5 ${isApplied ? "bg-filter-applied" : ""}`}
              >
                <input
                  type="checkbox"
                  aria-label={f.enabledLabel(row)}
                  title={hint(f.enabledLabel(row), "filters.toggle")}
                  aria-keyshortcuts={ariaShortcut(shortcut("filters.toggle"))}
                  checked={!off.has(d.id)}
                  onChange={() => toggle(d.id)}
                  className="size-3.5 shrink-0 accent-accent outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <select
                  data-field="column"
                  aria-label={f.columnLabel(row)}
                  className={`${field} w-44`}
                  value={columnValue(d.column)}
                  onChange={(e) => update(d.id, (x) => withColumn(x, columnFromValue(e.target.value)))}
                >
                  <option value="any">{f.anyColumn}</option>
                  <option value="raw">{f.rawSql}</option>
                  {columnChoices.map((c) => (
                    <option key={c} value={columnValue(c)}>
                      {c}
                    </option>
                  ))}
                </select>
                {d.column !== RAW_SQL && (
                  <select
                    aria-label={f.opLabel(row)}
                    className={`${field} w-32`}
                    value={d.op}
                    onChange={(e) => update(d.id, (x) => withOp(x, e.target.value as FilterOp))}
                  >
                    {opChoices.map((o) => (
                      <option key={o} value={o}>
                        {f.ops[o]}
                      </option>
                    ))}
                  </select>
                )}
                {d.column === RAW_SQL ? (
                  <input
                    type="text"
                    data-field="value"
                    aria-label={f.rawLabel(row)}
                    aria-describedby={reading ? readingId : undefined}
                    placeholder={f.rawPlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                    className={`${field} flex-1 font-mono`}
                    value={d.values[0] ?? ""}
                    onChange={(e) => setValue(0, e.target.value)}
                  />
                ) : arity === "list" ? (
                  <input
                    type="text"
                    data-field="value"
                    aria-label={f.listLabel(row)}
                    placeholder={f.listPlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                    className={`${field} flex-1`}
                    value={d.list}
                    onChange={(e) => update(d.id, (x) => ({ ...x, list: e.target.value }))}
                  />
                ) : arity === 0 ? (
                  <span className="flex-1" />
                ) : (
                  <>
                    <input
                      type="text"
                      data-field="value"
                      aria-label={f.valueLabel(row)}
                      placeholder={f.valuePlaceholder}
                      spellCheck={false}
                      autoComplete="off"
                      className={`${field} flex-1`}
                      value={d.values[0] ?? ""}
                      onChange={(e) => setValue(0, e.target.value)}
                    />
                    {arity === 2 && (
                      <>
                        <span className="text-text">{f.and}</span>
                        <input
                          type="text"
                          aria-label={f.secondValueLabel(row)}
                          spellCheck={false}
                          autoComplete="off"
                          className={`${field} flex-1`}
                          value={d.values[1] ?? ""}
                          onChange={(e) => setValue(1, e.target.value)}
                        />
                      </>
                    )}
                  </>
                )}
                {reading && (
                  <span
                    data-testid="raw-reading"
                    title={`${
                      reading.kind === "bound" ? f.rawRead.boundHint : reading.kind === "sql" ? f.rawRead.sqlHint : reading.message
                    } ${f.rawRead.applyNote}`}
                    className={`shrink-0 text-xs ${reading.kind === "error" ? "text-danger" : "text-text"}`}
                  >
                    <span aria-hidden="true">
                      {reading.kind === "bound" ? f.rawRead.bound : reading.kind === "sql" ? f.rawRead.sql : f.rawRead.error}
                    </span>
                    <span id={readingId} hidden>
                      {`${reading.kind === "bound" ? f.rawRead.boundHint : reading.kind === "sql" ? f.rawRead.sqlHint : reading.message} ${f.rawRead.applyNote}`}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  className={button}
                  aria-label={f.applyRow(row)}
                  title={f.withShortcut(f.applyRow(row), formatShortcut("Enter"))}
                  onClick={() => applyRow(d.id)}
                >
                  {f.applyRowText}
                </button>
                <button
                  type="button"
                  className={button}
                  aria-label={f.addAfter(row)}
                  title={hint(f.addAfter(row), "filters.add")}
                  aria-keyshortcuts={ariaShortcut(shortcut("filters.add"))}
                  onClick={() => addAfter(d.id)}
                >
                  {f.addAfterText}
                </button>
                <button
                  type="button"
                  className={button}
                  aria-label={f.removeRow(row)}
                  title={hint(f.removeRow(row), "filters.remove")}
                  aria-keyshortcuts={ariaShortcut(shortcut("filters.remove"))}
                  onClick={() => remove(d.id)}
                >
                  {f.removeRowText}
                </button>
              </div>
              {errors[d.id] && (
                <p role="alert" className="pb-1 pl-6 text-danger">
                  {errors[d.id]}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div role="group" aria-label={f.applyAllGroup} className="flex h-[38px] shrink-0 items-center gap-1.5">
        <button
          type="button"
          className={button}
          title={hint(f.applyAll, mode === "or" ? "filters.applyAllOr" : "filters.applyAll")}
          aria-keyshortcuts={ariaShortcut(shortcut("filters.applyAll"))}
          onClick={() => applyAll(mode)}
        >
          {f.applyAll}
        </button>
        <div role="group" aria-label={f.combineLabel} className="flex">
          <button
            type="button"
            aria-pressed={mode === "and"}
            title={hint(f.combineAnd, "filters.applyAll")}
            className={`${button} rounded-r-none`}
            onClick={() => setMode("and")}
          >
            {f.combineAnd}
          </button>
          <button
            type="button"
            aria-pressed={mode === "or"}
            title={hint(f.combineOr, "filters.applyAllOr")}
            aria-keyshortcuts={ariaShortcut(shortcut("filters.applyAllOr"))}
            className={`${button} -ml-px rounded-l-none`}
            onClick={() => setMode("or")}
          >
            {f.combineOr}
          </button>
        </div>
      </div>
    </div>
  );
}
