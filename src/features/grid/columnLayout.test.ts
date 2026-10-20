import { expect, test } from "vitest";
import {
  COL_MAX,
  COL_MIN,
  autoSizeColumns,
  fitColumn,
  moveColumn,
  reconcileLayout,
  type ColumnMeasure,
} from "./columnLayout";

/** Monospace-like: 8 px per character for data, 7 px for headers. */
const measure: ColumnMeasure = { text: (s) => s.length * 8, header: (s) => s.length * 7 };

test("columns_autosize_within_bounds: the page content sets each width, between 60 and 400 px", () => {
  const names = ["id", "note", "blob"];
  const rows = [
    ["1", "short", "x".repeat(500)],
    ["22", "a much longer note here", "y"],
  ];
  const w = autoSizeColumns(names, rows.length, (r, c) => rows[r][c], measure);
  expect(w.id).toBe(COL_MIN);
  // The longest note (23 chars × 8) plus the padding, under the cap.
  expect(w.note).toBeGreaterThan(23 * 8);
  expect(w.note).toBeLessThan(COL_MAX);
  expect(w.blob).toBe(COL_MAX);
  // A long header wins over short values.
  const h = autoSizeColumns(["a_rather_long_column_name"], 1, () => "1", measure);
  expect(h.a_rather_long_column_name).toBeGreaterThan(25 * 7);
});

test("auto-size reads at most the sampled rows of a long page and stays fast on wide pages", () => {
  let reads = 0;
  const names = Array.from({ length: 200 }, (_, i) => `c${i}`);
  const start = performance.now();
  autoSizeColumns(names, 5000, () => {
    reads++;
    return "value";
  }, measure);
  expect(reads).toBeLessThanOrEqual(200 * 1000);
  expect(performance.now() - start).toBeLessThan(1000);
});

test("fitColumn measures one column of the page", () => {
  const rows = [["abc"], ["abcdefghij"]];
  expect(fitColumn("x", rows.length, (r) => rows[r][0], measure)).toBe(
    autoSizeColumns(["x"], rows.length, (r, c) => rows[r][c], measure).x,
  );
});

test("reconcileLayout keeps what still applies to the current columns", () => {
  const cols = ["id", "name", "email"];
  // Nothing stored: the table's order, nothing hidden, no widths.
  expect(reconcileLayout(undefined, cols)).toEqual({ order: cols, hidden: [], widths: {} });
  // A stale layout: dropped columns forgotten, new ones appended, bad widths ignored.
  const stale = {
    order: ["email", "gone", "id"],
    hidden: ["gone", "name"],
    widths: { id: 120, gone: 90, email: Number.NaN, name: -4 },
  };
  expect(reconcileLayout(stale, cols)).toEqual({
    order: ["email", "id", "name"],
    hidden: ["name"],
    widths: { id: 120 },
  });
  // Garbage of the wrong shape breaks nothing.
  for (const junk of [null, 42, "x", { order: "id", hidden: {}, widths: [] }, { order: [1, null, "id", "id"] }]) {
    expect(reconcileLayout(junk as never, cols)).toEqual({ order: cols, hidden: [], widths: {} });
  }
  // Every column hidden: the first one stays shown (a grid always has a column).
  expect(reconcileLayout({ order: cols, hidden: cols, widths: {} }, cols).hidden).toEqual(["name", "email"]);
});

test("moveColumn moves a name of the visible order, hidden columns keep their place", () => {
  const order = ["a", "b", "c", "d"];
  // Visible: a, c, d (b hidden). Move visible 0 (a) to visible 2 (after d).
  expect(moveColumn(order, ["b"], 0, 2)).toEqual(["b", "c", "d", "a"]);
  expect(moveColumn(order, [], 3, 0)).toEqual(["d", "a", "b", "c"]);
  expect(moveColumn(order, [], 1, 1)).toBe(order);
  expect(moveColumn(order, [], 7, 0)).toBe(order);
});
