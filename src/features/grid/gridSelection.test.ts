import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { expect, test } from "vitest";
import { selectedRowOf, withSelectedRow } from "./gridSelection";

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
