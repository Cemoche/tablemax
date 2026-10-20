// Column widths and order of a grid: auto-size on the page content, fit one column, move a
// column, and read a stored layout back against the columns a table has now. Pure.
import type { ColumnLayout } from "../../lib/columnLayout";

export type { ColumnLayout };

/** Bounds of an automatic width (spec §2.3); a width dragged by hand has wider ones. */
export const COL_MIN = 60;
export const COL_MAX = 400;
/** Bounds of a width dragged by hand (Glide's resize limits). */
export const RESIZE_MIN = 40;
export const RESIZE_MAX = 2000;
/** Glide's cell padding, on each side. */
const PAD = 8;
/** Room for the sort arrow after a header title. */
const SORT_ROOM = 16;
/** At most this many rows of a page are read to size its columns (a long page stays fast). */
export const SAMPLE_ROWS = 1000;

/** Text widths in px: `text` in the data font, `header` in the header font. */
export interface ColumnMeasure {
  text: (s: string) => number;
  header: (s: string) => number;
}


const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The width of one column: its widest value among the first SAMPLE_ROWS rows, or its
 * header, padded, between COL_MIN and COL_MAX. The data font is monospace, so the longest
 * string is the widest: only that one is measured.
 */
export function fitColumn(
  name: string,
  rowCount: number,
  text: (row: number) => string,
  measure: ColumnMeasure,
): number {
  let longest = "";
  const n = Math.min(rowCount, SAMPLE_ROWS);
  for (let r = 0; r < n; r++) {
    const s = text(r);
    if (s.length > longest.length) longest = s;
  }
  const content = Math.max(measure.text(longest), measure.header(name) + SORT_ROOM);
  return clamp(Math.ceil(content + 2 * PAD), COL_MIN, COL_MAX);
}

/** `fitColumn` for every column (`text(row, col)` is the displayed text). */
export function autoSizeColumns(
  names: string[],
  rowCount: number,
  text: (row: number, col: number) => string,
  measure: ColumnMeasure,
): Record<string, number> {
  const out: Record<string, number> = {};
  names.forEach((name, c) => {
    out[name] = fitColumn(name, rowCount, (r) => text(r, c), measure);
  });
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The distinct names of `v` that are columns now, in their stored order. */
function knownNames(v: unknown, columns: Set<string>): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const n of v) if (typeof n === "string" && columns.has(n) && !out.includes(n)) out.push(n);
  return out;
}

/**
 * A stored layout read against the table's columns now: dropped columns forgotten, new ones
 * appended to the order, widths that are not finite numbers in the resize bounds ignored,
 * and at least one column left shown. Anything of the wrong shape counts as nothing.
 */
export function reconcileLayout(stored: unknown, columns: string[]): ColumnLayout {
  const names = new Set(columns);
  const s = isRecord(stored) ? stored : {};
  const order = knownNames(s.order, names);
  for (const c of columns) if (!order.includes(c)) order.push(c);
  let hidden = knownNames(s.hidden, names);
  if (hidden.length > 0 && hidden.length >= columns.length) {
    hidden = hidden.filter((h) => h !== order[0]);
  }
  const widths: Record<string, number> = {};
  if (isRecord(s.widths)) {
    for (const [name, w] of Object.entries(s.widths)) {
      if (names.has(name) && typeof w === "number" && Number.isFinite(w) && w >= RESIZE_MIN && w <= RESIZE_MAX) {
        widths[name] = w;
      }
    }
  }
  return { order, hidden, widths };
}

/**
 * `order` after the shown column at index `from` moved to shown index `to` (shown = not in
 * `hidden`); hidden columns keep their place. The same array when nothing moves.
 */
export function moveColumn(order: string[], hidden: string[], from: number, to: number): string[] {
  const shown = order.filter((n) => !hidden.includes(n));
  if (from === to || from < 0 || to < 0 || from >= shown.length || to >= shown.length) return order;
  const name = shown[from];
  const target = shown[to];
  const rest = order.filter((n) => n !== name);
  const at = rest.indexOf(target);
  rest.splice(from < to ? at + 1 : at, 0, name);
  return rest;
}
