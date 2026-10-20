// The table grid's selection as one row: what DataGrid reports, and how it follows the
// selected record when display rows move (inserts, reloads, page changes). Pure.
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";

const EMPTY: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

/** The current cell's row, else the first selected row, else null. */
export function selectedRowOf(s: GridSelection): number | null {
  return s.current?.cell[1] ?? s.rows.first() ?? null;
}

/**
 * `s` moved to `row`: the same object when it is already there, selected rows shifted with
 * their first one, the current cell moved to `row` in the same column (column 0 without
 * one), or no selection for null.
 */
export function withSelectedRow(s: GridSelection, row: number | null): GridSelection {
  const now = selectedRowOf(s);
  if (now === row) return s;
  if (row === null) return EMPTY;
  // Whole rows selected by their numbers: they all move with the record (rows added above).
  if (!s.current && now !== null && s.rows.length > 0) {
    const moved = s.rows.offset(row - now);
    if (moved.first() === row) return { ...EMPTY, rows: moved };
  }
  const col = s.current?.cell[0] ?? 0;
  return {
    ...EMPTY,
    current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
  };
}

/** Display rows × columns of the grid, both ascending. */
export interface CellBlock {
  rows: number[];
  cols: number[];
}

const span = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

/**
 * The cells a selection covers: whole rows (every column), whole columns (every row), else
 * the current range (other ranges of a multi-range selection are ignored); null when empty.
 */
export function selectionBlock(s: GridSelection, rowCount: number, colCount: number): CellBlock | null {
  if (s.rows.length > 0) return { rows: s.rows.toArray(), cols: span(0, colCount) };
  if (s.columns.length > 0) return { rows: span(0, rowCount), cols: s.columns.toArray() };
  const r = s.current?.range;
  return r ? { rows: span(r.y, r.height), cols: span(r.x, r.width) } : null;
}

/**
 * What a right click on (`row`, `col`) acts on: the selection when it holds that cell (or,
 * on the row marker, `col` null, that row), else the cell alone or the whole row.
 */
export function blockAt(block: CellBlock | null, row: number, col: number | null, colCount: number): CellBlock {
  if (block && block.rows.includes(row) && (col === null ? block.cols.length === colCount : block.cols.includes(col))) {
    return block;
  }
  return { rows: [row], cols: col === null ? span(0, colCount) : [col] };
}

/**
 * A click on the number of `row` (#78): only that row; with `shift`, the rows from the
 * anchor (the last row clicked without Shift) to `row`; with `toggle` (Ctrl, Cmd on macOS),
 * that row added or removed. The current cell is dropped (whole rows are selected).
 */
export function rowMarkerClick(
  s: GridSelection,
  row: number,
  anchor: number | null,
  mods: { shift?: boolean; toggle?: boolean },
): { selection: GridSelection; anchor: number | null } {
  if (mods.shift && anchor !== null) {
    const from = Math.min(anchor, row);
    const to = Math.max(anchor, row);
    return { selection: { ...EMPTY, rows: CompactSelection.fromSingleSelection([from, to + 1]) }, anchor };
  }
  if (mods.toggle) {
    const rows = s.rows.hasIndex(row) ? s.rows.remove(row) : s.rows.add(row);
    return { selection: { ...EMPTY, rows }, anchor: row };
  }
  return { selection: { ...EMPTY, rows: CompactSelection.fromSingleSelection(row) }, anchor: row };
}

/** The rows drawn as selected: whole selected rows and the rows of the current range(s). */
export function highlightedRows(s: GridSelection): Set<number> {
  const out = new Set<number>(s.rows.toArray());
  const cur = s.current;
  if (cur) {
    for (const r of [cur.range, ...cur.rangeStack]) {
      for (let y = r.y; y < r.y + r.height; y++) out.add(y);
    }
  }
  return out;
}
