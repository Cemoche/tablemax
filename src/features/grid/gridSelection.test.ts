import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { expect, test } from "vitest";
import { blockAt, selectedRowOf, selectionBlock, withSelectedRow } from "./gridSelection";

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
  expect(withSelectedRow({ ...empty, rows: CompactSelection.fromSingleSelection(4) }, 5)).toEqual(at(0, 5));
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
