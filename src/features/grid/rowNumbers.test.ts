import { InnerGridCellKind, type MarkerCell, markerCellRenderer } from "@glideapps/glide-data-grid";
import { expect, test, vi } from "vitest";
import { ROW_NUMBER_PAD, type RowNumberStyle, gridRenderers, rowNumberRenderer } from "./rowNumbers";

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

const style = (selected: number[]): RowNumberStyle => ({
  selected: (r) => selected.includes(r),
  family: "system-ui, sans-serif",
  selectedFill: "#0062CC",
  selectedText: "#FFFFFF",
});

function draw(s: RowNumberStyle, row: number, cell = marker(row + 1)) {
  const { ctx, calls } = fakeCtx();
  const renderer = rowNumberRenderer(() => s);
  renderer.draw(
    {
      ctx,
      rect: { x: 0, y: 26 * row, width: 46, height: 26 },
      theme: { textLight: "#6E6E6E", markerFontStyle: "11px" },
      row,
      col: 0,
      cell,
    } as unknown as Parameters<typeof renderer.draw>[0],
    cell,
  );
  return calls;
}

test("row numbers are right-aligned, in --rownum and the interface font, on the row's own background", () => {
  const calls = draw(style([]), 2);
  // No fill: the row's background (zebra included) shows.
  expect(calls.map((c) => c.op)).toEqual(["fillText"]);
  const [text] = calls;
  expect(text.args[0]).toBe("3");
  expect(text.args[1]).toBe(46 - ROW_NUMBER_PAD);
  expect(text.textAlign).toBe("right");
  expect(text.fillStyle).toBe("#6E6E6E");
  expect(text.font).toBe("11px system-ui, sans-serif");
});

test("a selected row's number is white on the deeper accent fill", () => {
  const calls = draw(style([2]), 2);
  expect(calls[0]).toMatchObject({ op: "fillRect", args: [0, 52, 46, 26], fillStyle: "#0062CC" });
  expect(calls[1]).toMatchObject({ op: "fillText", fillStyle: "#FFFFFF", textAlign: "right" });
});

test("missing tokens: the selected row keeps its own fill and textLight", () => {
  const calls = draw({ ...style([2]), selectedFill: "", selectedText: "" }, 2);
  expect(calls.map((c) => c.op)).toEqual(["fillText"]);
  expect(calls[0].fillStyle).toBe("#6E6E6E");
});

test("the renderer list swaps only Glide's marker renderer", () => {
  const list = gridRenderers(() => style([]));
  const markers = list.filter((r) => r.kind === InnerGridCellKind.Marker);
  expect(markers).toHaveLength(1);
  expect(markers[0]).not.toBe(markerCellRenderer);
  expect(markers[0].drawPrep).toBeUndefined();
  expect(list.some((r) => r.kind === "text")).toBe(true);
});
