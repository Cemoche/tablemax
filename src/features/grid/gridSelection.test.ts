import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { expect, test } from "vitest";
import { blockAt, highlightedRows, rowMarkerClick, selectedRowOf, selectionBlock, withSelectedRow } from "./gridSelection";

const empty: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };
const at = (col: number, row: number): GridSelection => ({
  ...empty,
  current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
});

test("the selected row is the current cell's row, else the first selected row", () => {
  expect(selectedRowOf(empty)).toBeNull();
  expect(selectedRowOf(at(2, 5))).toBe(5);
  expect(selectedRowOf({ ...empty, rows: CompactSelection.fromSingleSelection(4) })).toBe(4);
});

test("withSelectedRow keeps a selection already on that row", () => {
  const s = at(2, 5);
  expect(withSelectedRow(s, 5)).toBe(s);
  expect(withSelectedRow(empty, null)).toBe(empty);
});

test("withSelectedRow moves the current cell (same column) or clears the selection", () => {
  expect(withSelectedRow(at(2, 5), 6)).toEqual(at(2, 6));
  expect(withSelectedRow(at(2, 5), null)).toEqual(empty);
  // Rows selected by their numbers move together with the first one (a row added above).
  expect(withSelectedRow({ ...empty, rows: CompactSelection.fromSingleSelection([4, 7]) }, 5).rows.toArray()).toEqual([
    5, 6, 7,
  ]);
});

const rows = (...r: number[]): GridSelection => {
  let s = CompactSelection.empty();
  for (const i of r) s = s.add(i);
  return { ...empty, rows: s };
};

test("selectionBlock: a cell range, whole rows, whole columns, or nothing", () => {
  const range: GridSelection = {
    ...empty,
    current: { cell: [1, 2], range: { x: 1, y: 2, width: 2, height: 3 }, rangeStack: [] },
  };
  expect(selectionBlock(range, 10, 5)).toEqual({ rows: [2, 3, 4], cols: [1, 2] });
  expect(selectionBlock(rows(4, 1), 10, 3)).toEqual({ rows: [1, 4], cols: [0, 1, 2] });
  expect(selectionBlock({ ...empty, columns: CompactSelection.fromSingleSelection(2) }, 3, 5)).toEqual({
    rows: [0, 1, 2],
    cols: [2],
  });
  expect(selectionBlock(empty, 3, 5)).toBeNull();
});

test("blockAt keeps a selection holding the clicked cell, else uses the cell or its row", () => {
  const block = { rows: [2, 3], cols: [1, 2] };
  expect(blockAt(block, 3, 2, 5)).toBe(block);
  expect(blockAt(block, 3, null, 5)).toEqual({ rows: [3], cols: [0, 1, 2, 3, 4] });
  expect(blockAt(block, 7, 1, 5)).toEqual({ rows: [7], cols: [1] });
  expect(blockAt(null, 0, 4, 5)).toEqual({ rows: [0], cols: [4] });
  // A row marker inside selected whole rows keeps them.
  const whole = { rows: [0, 1], cols: [0, 1, 2] };
  expect(blockAt(whole, 1, null, 3)).toBe(whole);
});

const rowsOf = (s: GridSelection) => s.rows.toArray();

test("row_number_click_selects_row: a click selects the row, Shift extends from the anchor, Ctrl adds or removes", () => {
  let anchor: number | null = null;
  const click = (s: GridSelection, row: number, mods: { shift?: boolean; toggle?: boolean } = {}) => {
    const r = rowMarkerClick(s, row, anchor, mods);
    anchor = r.anchor;
    return r.selection;
  };
  let s = click(at(1, 7), 2);
  // Only that row: the current cell is dropped.
  expect(rowsOf(s)).toEqual([2]);
  expect(s.current).toBeUndefined();
  s = click(s, 5, { shift: true });
  expect(rowsOf(s)).toEqual([2, 3, 4, 5]);
  // Shift again extends from the same anchor (upwards too).
  s = click(s, 0, { shift: true });
  expect(rowsOf(s)).toEqual([0, 1, 2]);
  s = click(s, 1, { toggle: true });
  expect(rowsOf(s)).toEqual([0, 2]);
  s = click(s, 6, { toggle: true });
  expect(rowsOf(s)).toEqual([0, 2, 6]);
  // A plain click on a selected row keeps only that row.
  s = click(s, 2);
  expect(rowsOf(s)).toEqual([2]);
  // Shift with no anchor yet acts like a plain click.
  anchor = null;
  expect(rowsOf(click(empty, 3, { shift: true }))).toEqual([3]);
});

test("the highlighted rows are the selected rows and the rows of the current range", () => {
  expect(highlightedRows(empty).size).toBe(0);
  expect([...highlightedRows({ ...empty, rows: CompactSelection.fromSingleSelection([2, 4]) })]).toEqual([2, 3]);
  const range: GridSelection = {
    ...empty,
    current: { cell: [0, 3], range: { x: 0, y: 3, width: 2, height: 2 }, rangeStack: [] },
  };
  expect([...highlightedRows(range)].sort()).toEqual([3, 4]);
});
