import { expect, test, vi } from "vitest";
import { drawCenteredHeader } from "./headerLabels";

function fakeCtx(textWidth: number) {
  const calls: { args: unknown[]; fillStyle: string; font: string; textAlign: string }[] = [];
  // save / restore keep a real stack: the font after a restore is the one saved.
  const stack: { fillStyle: string; font: string; textAlign: string }[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textAlign: "start",
    save: () => stack.push({ fillStyle: ctx.fillStyle, font: ctx.font, textAlign: ctx.textAlign }),
    restore: () => Object.assign(ctx, stack.pop()),
    measureText: () => ({ width: textWidth, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 0 }),
    fillText: (...args: unknown[]) => calls.push({ args, fillStyle: ctx.fillStyle, font: ctx.font, textAlign: ctx.textAlign }),
  };
  return { ctx, calls };
}

const theme = { textHeader: "#262626", textHeaderSelected: "#FFFFFF", headerFontFull: "500 13px system-ui", cellHorizontalPadding: 8 };

function header(textWidth: number, column: Record<string, unknown> = { title: "relname" }, isSelected = false) {
  const { ctx, calls } = fakeCtx(textWidth);
  ctx.font = "13px JetBrains Mono";
  // The font Glide's own drawing would use (it sets none for header text).
  const drawContent = vi.fn(() => ctx.font);
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
  const wide = header(150);
  expect(wide.drawContent).toHaveBeenCalled();
  expect(wide.calls).toEqual([]);
  // Still the header font, not the data font Glide leaves on the context (review #103).
  expect(wide.drawContent.mock.results[0].value).toBe("500 13px system-ui");
  expect(header(10, { title: "", rowMarker: "number" }).drawContent).toHaveBeenCalled();
  expect(header(10, { title: "x", icon: "headerString" }).drawContent).toHaveBeenCalled();
});

test("a selected column header uses the selected header colour", () => {
  expect(header(20, { title: "id" }, true).calls[0].fillStyle).toBe("#FFFFFF");
});
