import { strings } from "../../lib/strings";
import type { Dialect, Filter, FilterOp } from "../../lib/types";
import { formatValueList, splitValueList } from "../../lib/valueList";

/** The "Any column" choice of a builder row (column names are free text, hence symbols). */
export const ANY_COLUMN: unique symbol = Symbol("anyColumn");
/** The "Raw SQL" choice: the row is the user's own SQL condition. */
export const RAW_SQL: unique symbol = Symbol("rawSql");

export type DraftColumn = string | typeof ANY_COLUMN | typeof RAW_SQL;

/** One builder row, as typed (not validated). */
export interface FilterDraft {
  id: string;
  column: DraftColumn;
  op: FilterOp;
  /** The value fields (0, 1 or 2 of them); unused by IN / NOT IN. */
  values: string[];
  /** The comma-separated text of IN / NOT IN. */
  list: string;
}

const COLUMN_OPS: FilterOp[] = [
  "eq", "neq", "lt", "gt", "lte", "gte",
  "in", "notIn", "between", "notBetween",
  "like", "notLike", "ilike", "contains", "notContains",
  "isNull", "isNotNull",
];
const ANY_OPS: FilterOp[] = ["eq", "contains", "notContains", "like"];

/** Operators a row may use: ILIKE on PostgreSQL only; Any column gets the four the backend allows. */
export function opsFor(dialect: Dialect, column: DraftColumn): FilterOp[] {
  if (column === RAW_SQL) return ["raw"];
  if (column === ANY_COLUMN) return ANY_OPS;
  return dialect === "postgres" ? COLUMN_OPS : COLUMN_OPS.filter((o) => o !== "ilike");
}

/** How many value fields an operator takes ("list" = one comma-separated field). */
export function arityOf(op: FilterOp): 0 | 1 | 2 | "list" {
  switch (op) {
    case "isNull":
    case "isNotNull":
      return 0;
    case "between":
    case "notBetween":
      return 2;
    case "in":
    case "notIn":
      return "list";
    default:
      return 1;
  }
}

let seq = 0;
const nextId = () => `f${++seq}`;

/** A fresh row: the first column (Any column without columns), `=`, one empty value. */
export function newDraft(columns: string[]): FilterDraft {
  return { id: nextId(), column: columns[0] ?? ANY_COLUMN, op: "eq", values: [""], list: "" };
}

/** The row with another operator; the values that still fit are kept. */
export function withOp(d: FilterDraft, op: FilterOp): FilterDraft {
  const from = arityOf(d.op) === "list" ? splitValueList(d.list).values : d.values;
  const to = arityOf(op);
  if (to === "list") {
    const list = arityOf(d.op) === "list" ? d.list : formatValueList(from.filter((v) => v !== ""));
    return { ...d, op, values: [], list };
  }
  const values = Array.from({ length: to }, (_, i) => from[i] ?? "");
  return { ...d, op, values, list: "" };
}

/** The row on another column; an operator the column does not allow becomes the first allowed one. */
export function withColumn(d: FilterDraft, column: DraftColumn): FilterDraft {
  // Raw SQL text and column values are unrelated: switching between them starts afresh.
  if (column === RAW_SQL) {
    return { ...d, column, op: "raw", values: [d.column === RAW_SQL ? (d.values[0] ?? "") : ""], list: "" };
  }
  if (d.column === RAW_SQL) return { ...d, column, op: "eq", values: [""], list: "" };
  // The dialect only removes ILIKE, which Any column never offers either.
  const allowed = opsFor("postgres", column);
  return allowed.includes(d.op) ? { ...d, column } : withOp({ ...d, column }, allowed[0]);
}

export function draftsFromFilters(filters: Filter[]): FilterDraft[] {
  return filters.map((f) => {
    const column = f.op === "raw" ? RAW_SQL : (f.column ?? ANY_COLUMN);
    const list = arityOf(f.op) === "list";
    return {
      id: nextId(),
      column,
      op: f.op,
      values: list ? [] : [...f.values],
      list: list ? formatValueList(f.values) : "",
    };
  });
}

/** The rows as filters, or a message per invalid row id (then no filters at all). */
export function filtersFromDrafts(drafts: FilterDraft[]): {
  filters: Filter[];
  errors: Record<string, string>;
} {
  const filters: Filter[] = [];
  const errors: Record<string, string> = {};
  for (const d of drafts) {
    if (d.column === RAW_SQL) {
      const sql = d.values[0] ?? "";
      if (sql.trim() === "") errors[d.id] = strings.filters.rawEmpty;
      else filters.push({ column: null, op: "raw", values: [sql] });
      continue;
    }
    const column = d.column === ANY_COLUMN ? null : d.column;
    if (arityOf(d.op) === "list") {
      const r = splitValueList(d.list);
      if (r.error !== null) errors[d.id] = r.error;
      else filters.push({ column, op: d.op, values: r.values });
    } else {
      filters.push({ column, op: d.op, values: [...d.values] });
    }
  }
  return Object.keys(errors).length > 0 ? { filters: [], errors } : { filters, errors };
}
