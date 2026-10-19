import { expect, test } from "vitest";
import { contrastRatio } from "./contrast";

test("black on white is 21:1 and the ratio is symmetric", () => {
  expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
});

test("same color is 1:1, case and short hex accepted", () => {
  expect(contrastRatio("#abcdef", "#ABCDEF")).toBeCloseTo(1, 5);
  expect(contrastRatio("#fff", "#FFFFFF")).toBeCloseTo(1, 5);
});

test("known WCAG value: #767676 on white is about 4.54", () => {
  expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
});

test("an unparsable color throws rather than passing a contrast check", () => {
  expect(() => contrastRatio("var(--x)", "#FFFFFF")).toThrow();
  expect(() => contrastRatio("#12345", "#FFFFFF")).toThrow();
});
