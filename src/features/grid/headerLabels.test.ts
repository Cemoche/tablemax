import { expect, test, vi } from "vitest";
import { drawCenteredHeader } from "./headerLabels";

function fakeCtx(textWidth: number) {
  const calls: { args: unknown[]; fillStyle: string; font: string; textAlign: string }[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textAlign: "start",
    save: vi.fn(),
    restore: vi.fn(),
    measureText: () => ({ width: textWidth, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 0 }),
    fillText: (...args: unknown[]) => calls.push({ args, fillStyle: ctx.fillStyle, font: ctx.font, textAlign: ctx.textAlign }),
  };
  return { ctx, calls };
}

const theme = { textHeader: "#262626", textHeaderSelected: "#FFFFFF", headerFontFull: "500 13px system-ui", cellHorizontalPadding: 8 };

function header(textWidth: number, column: Record<string, unknown> = { title: "relname" }, isSelected = false) {
  const { ctx, calls } = fakeCtx(textWidth);
  const drawContent = vi.fn();
  drawCenteredHeader(
    {
      ctx,
      theme,
      rect: { x: 100, y: 0, width: 160, height: 30 },
      column,
      columnIndex: 2,
      isSelected,
    } as never,
    drawContent,
  );
  return { calls, drawContent };
}

test("centred_headers: a label that fits is centred over its column, in the header colour and font", () => {
  const { calls, drawContent } = header(60);
  expect(drawContent).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ fillStyle: "#262626", font: "500 13px system-ui", textAlign: "center" });
  expect(calls[0].args[0]).toBe("relname");
  expect(calls[0].args[1]).toBe(180);
});

test("a label wider than its column, the row number corner and icon columns keep Glide's drawing", () => {
  // 160 - 2 × 8 padding = 144: a 150 px label does not fit.
  expect(header(150).drawContent).toHaveBeenCalled();
  expect(header(150).calls).toEqual([]);
  expect(header(10, { title: "", rowMarker: "number" }).drawContent).toHaveBeenCalled();
  expect(header(10, { title: "x", icon: "headerString" }).drawContent).toHaveBeenCalled();
});

test("a selected column header uses the selected header colour", () => {
  expect(header(20, { title: "id" }, true).calls[0].fillStyle).toBe("#FFFFFF");
});
