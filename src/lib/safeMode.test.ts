import { expect, test } from "vitest";
import { parseConfirmationIndices } from "./errors";
import { effectiveSafeMode, enforcedSafeMode, stricterSafeMode } from "./safeMode";
import { windowTitle } from "./windowTitle";

test("effective safe mode: prod confirms writes, others are off, explicit wins", () => {
  expect(effectiveSafeMode({ envTag: "prod" })).toBe("confirmWrites");
  expect(effectiveSafeMode({ envTag: "prod", safeMode: null })).toBe("confirmWrites");
  for (const t of ["local", "dev", "staging"] as const) {
    expect(effectiveSafeMode({ envTag: t })).toBe("off");
  }
  expect(effectiveSafeMode({ envTag: "prod", safeMode: "off" })).toBe("off");
  expect(effectiveSafeMode({ envTag: "dev", safeMode: "confirmAll" })).toBe("confirmAll");
});

test("confirmation indices parse, and anything unparsable means every statement", () => {
  expect(parseConfirmationIndices("1", 3)).toEqual([1]);
  expect(parseConfirmationIndices("0,1,2", 3)).toEqual([0, 1, 2]);
  expect(parseConfirmationIndices("2, 0", 3)).toEqual([0, 2]);
  expect(parseConfirmationIndices("", 2)).toEqual([0, 1]);
  expect(parseConfirmationIndices("oops", 2)).toEqual([0, 1]);
  expect(parseConfirmationIndices("1,x", 2)).toEqual([0, 1]);
  expect(parseConfirmationIndices("7", 2)).toEqual([0, 1]);
});

test("window title shows the tag for prod and staging only", () => {
  expect(windowTitle(null)).toBe("TableMax");
  expect(windowTitle({ name: "Shop", envTag: "prod" })).toBe("TableMax — Shop [PROD]");
  expect(windowTitle({ name: "Shop", envTag: "staging" })).toBe("TableMax — Shop [STAGING]");
  expect(windowTitle({ name: "Shop", envTag: "dev" })).toBe("TableMax — Shop");
  expect(windowTitle({ name: "Shop", envTag: "local" })).toBe("TableMax — Shop");
});

test("stricter safe mode orders off < confirmWrites < confirmAll", () => {
  expect(stricterSafeMode("off", "confirmWrites")).toBe("confirmWrites");
  expect(stricterSafeMode("confirmAll", "confirmWrites")).toBe("confirmAll");
  expect(stricterSafeMode("off", "off")).toBe("off");
});

test("enforced mode (R16): stricter of saved and opened, opened alone when deleted", () => {
  const prod = { envTag: "prod" as const, safeMode: null };
  const dev = { envTag: "dev" as const, safeMode: null };
  // Loosening waits for the next open.
  expect(enforcedSafeMode(dev, prod)).toBe("confirmWrites");
  expect(enforcedSafeMode({ envTag: "prod", safeMode: "off" }, prod)).toBe("confirmWrites");
  // Tightening applies at once.
  expect(enforcedSafeMode(prod, dev)).toBe("confirmWrites");
  expect(enforcedSafeMode({ envTag: "dev", safeMode: "confirmAll" }, prod)).toBe("confirmAll");
  // Deleted connection: the opened config.
  expect(enforcedSafeMode(undefined, prod)).toBe("confirmWrites");
  expect(enforcedSafeMode(undefined, dev)).toBe("off");
});
