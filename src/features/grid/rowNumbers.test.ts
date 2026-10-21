import { InnerGridCellKind, type MarkerCell, markerCellRenderer } from "@glideapps/glide-data-grid";
import { expect, test, vi } from "vitest";
import { ROW_NUMBER_MIN_WIDTH, ROW_NUMBER_PAD, type RowNumberStyle, gridRenderers, rowNumberRenderer, rowNumberWidth } from "./rowNumbers";

/** A canvas context that records what is drawn. */
function fakeCtx() {
  const calls: { op: string; args: unknown[]; fillStyle: string; font: string; textAlign: string }[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textAlign: "start",
    save: vi.fn(),
    restore: vi.fn(),
    measureText: () => ({ actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 0, width: 10 }),
    fillRect: (...args: unknown[]) => calls.push({ op: "fillRect", args, fillStyle: ctx.fillStyle, font: ctx.font, textAlign: ctx.textAlign }),
    fillText: (...args: unknown[]) => calls.push({ op: "fillText", args, fillStyle: ctx.fillStyle, font: ctx.font, textAlign: ctx.textAlign }),
  };
  return { ctx, calls };
}

const marker = (row: number, markerKind: MarkerCell["markerKind"] = "number"): MarkerCell => ({
  kind: InnerGridCellKind.Marker,
  allowOverlay: false,
  row,
  markerKind,
  checked: false,
  drawHandle: false,
  checkboxStyle: "square",
});

const style = (selected: number[], failed: number[] = []): RowNumberStyle => ({
  selected: (r) => selected.includes(r),
  failed: (r) => failed.includes(r),
  failedText: "#AD2323",
  family: "system-ui, sans-serif",
  fill: "#F5F5F5",
  text: "#262626",
  selectedFill: "#0062CC",
  selectedText: "#FFFFFF",
});

function draw(s: RowNumberStyle, row: number, cell = marker(row + 1), bgCell = "#FFFFFF") {
  const { ctx, calls } = fakeCtx();
  const renderer = rowNumberRenderer(() => s);
  renderer.draw(
    {
      ctx,
      rect: { x: 0, y: 26 * row, width: 46, height: 26 },
      theme: { textLight: "#6E6E6E", markerFontStyle: "11px", bgCell },
      row,
      col: 0,
      cell,
    } as unknown as Parameters<typeof renderer.draw>[0],
    cell,
  );
  return calls;
}

test("row numbers are right-aligned in the interface font, in the header's colours on every row (no zebra, #103)", () => {
  // Odd row (zebra), an inserted row, a deleted row: the row's own background never shows.
  for (const bg of ["#F4F5F5", "#DAEBC2", "#F5A6B0"]) {
    const calls = draw(style([]), 2, marker(3), bg);
    expect(calls.map((c) => c.op)).toEqual(["fillRect", "fillText"]);
    expect(calls[0]).toMatchObject({ args: [0, 52, 46, 26], fillStyle: "#F5F5F5" });
    const text = calls[1];
    expect(text.args[0]).toBe("3");
    expect(text.args[1]).toBe(46 - ROW_NUMBER_PAD);
    expect(text.textAlign).toBe("right");
    expect(text.fillStyle).toBe("#262626");
    expect(text.font).toBe("11px system-ui, sans-serif");
  }
});

test("a selected row's number is white on the selected rows' fill", () => {
  const calls = draw(style([2]), 2);
  expect(calls[0]).toMatchObject({ op: "fillRect", args: [0, 52, 46, 26], fillStyle: "#0062CC" });
  expect(calls[1]).toMatchObject({ op: "fillText", fillStyle: "#FFFFFF", textAlign: "right" });
});

test("a failed row's number is red on the header fill; selected, it stays white (#129)", () => {
  // Inserted, deleted or updated: the number is the row's only red cue on a change fill.
  for (const bg of ["#FFFFFF", "#DAEBC2", "#F5A6B0"]) {
    const calls = draw(style([], [2]), 2, marker(3), bg);
    expect(calls[0]).toMatchObject({ op: "fillRect", fillStyle: "#F5F5F5" });
    expect(calls[1]).toMatchObject({ op: "fillText", fillStyle: "#AD2323" });
  }
  expect(draw(style([2], [2]), 2)[1]).toMatchObject({ op: "fillText", fillStyle: "#FFFFFF" });
  // Other rows keep the header's text; a missing token keeps it too.
  expect(draw(style([], [2]), 1)[1].fillStyle).toBe("#262626");
  expect(draw({ ...style([], [2]), failedText: "" }, 2)[1].fillStyle).toBe("#262626");
});

test("missing tokens: the row's own fill and textLight", () => {
  const calls = draw({ ...style([2]), fill: "", text: "", selectedFill: "", selectedText: "" }, 2);
  expect(calls.map((c) => c.op)).toEqual(["fillText"]);
  expect(calls[0].fillStyle).toBe("#6E6E6E");
  expect(draw({ ...style([]), fill: "", text: "" }, 1).map((c) => c.op)).toEqual(["fillText"]);
});

test("the renderer list swaps only Glide's marker renderer", () => {
  const list = gridRenderers(() => style([]));
  const markers = list.filter((r) => r.kind === InnerGridCellKind.Marker);
  expect(markers).toHaveLength(1);
  expect(markers[0]).not.toBe(markerCellRenderer);
  expect(markers[0].drawPrep).toBeUndefined();
  expect(list.some((r) => r.kind === "text")).toBe(true);
});

test("the numbers column widens for long numbers and large fonts, never under 46 px (review #102)", () => {
  // Default data size 13 (numbers at 11 px): 46 px up to 4 digits.
  expect(rowNumberWidth(300, 11)).toBe(ROW_NUMBER_MIN_WIDTH);
  expect(rowNumberWidth(9999, 11)).toBe(ROW_NUMBER_MIN_WIDTH);
  expect(rowNumberWidth(0, 11)).toBe(ROW_NUMBER_MIN_WIDTH);
  // Data size 24 (numbers at 22 px): 4 digits need more than 46 px.
  const w = rowNumberWidth(1000, 22);
  expect(w).toBeGreaterThan(ROW_NUMBER_MIN_WIDTH);
  // Room for every digit (about 0.6 em each) and the padding on both sides.
  expect(w).toBeGreaterThanOrEqual(4 * 22 * 0.6 + 2 * ROW_NUMBER_PAD);
  expect(rowNumberWidth(100000, 11)).toBeGreaterThan(rowNumberWidth(10000, 11));
});

test("other marker kinds draw as Glide does, prep included", () => {
  const { ctx, calls } = fakeCtx();
  const renderer = rowNumberRenderer(() => style([]));
  const cell = marker(3, "checkbox");
  const draw = vi.spyOn(markerCellRenderer, "draw").mockImplementation(() => {});
  const prep = vi.spyOn(markerCellRenderer, "drawPrep");
  renderer.draw({ ctx, rect: { x: 0, y: 0, width: 46, height: 26 }, theme: {}, row: 2, col: 0, cell } as never, cell);
  expect(prep).toHaveBeenCalled();
  expect(draw).toHaveBeenCalled();
  expect(calls).toEqual([]);
  expect(ctx.textAlign).toBe("start");
  draw.mockRestore();
  prep.mockRestore();
});
