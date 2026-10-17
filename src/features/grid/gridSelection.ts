// The table grid's selection as one row: what DataGrid reports, and how it follows the
// selected record when display rows move (inserts, reloads, page changes). Pure.
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";

const EMPTY: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

/** The current cell's row, else the first selected row, else null. */
export function selectedRowOf(s: GridSelection): number | null {
  return s.current?.cell[1] ?? s.rows.first() ?? null;
}

/**
 * `s` moved to `row`: the same object when it is already there, the current cell moved
 * to `row` in the same column (column 0 without one), or no selection for null.
 */
export function withSelectedRow(s: GridSelection, row: number | null): GridSelection {
  if (selectedRowOf(s) === row) return s;
  if (row === null) return EMPTY;
  const col = s.current?.cell[0] ?? 0;
  return {
    ...EMPTY,
    current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
  };
}
