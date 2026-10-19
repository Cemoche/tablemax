import { expect, test } from "vitest";
import { formatValueList, splitValueList } from "./valueList";

const ok = (s: string) => {
  const r = splitValueList(s);
  expect(r.error).toBeNull();
  return r.values;
};
const bad = (s: string) => {
  const r = splitValueList(s);
  expect(r.values).toEqual([]);
  expect(r.error).not.toBeNull();
  return r.error;
};

test("splits bare values on commas and trims them", () => {
  expect(ok("1, 2,3")).toEqual(["1", "2", "3"]);
  expect(ok("  New York ,Paris  ")).toEqual(["New York", "Paris"]);
  expect(ok("single")).toEqual(["single"]);
});

test("quoted values keep commas, spaces and doubled quotes, like the quick filter", () => {
  expect(ok("'a, b', \"c\"")).toEqual(["a, b", "c"]);
  expect(ok("'O''Brien', \"say \"\"hi\"\"\"")).toEqual(["O'Brien", 'say "hi"']);
  expect(ok("' padded ', ''")).toEqual([" padded ", ""]);
});

test("errors: nothing, empty items, unterminated quotes, text after a quote, stray quotes", () => {
  expect(bad("")).toMatch(/at least one value/);
  expect(bad("   ")).toMatch(/at least one value/);
  expect(bad("a,,b")).toMatch(/empty value/);
  expect(bad("a,")).toMatch(/empty value/);
  expect(bad("'abc")).toMatch(/unterminated/);
  expect(bad("'a' b")).toMatch(/after a quoted value/);
  expect(bad("O'Brien")).toMatch(/quote/);
});

test("formatValueList quotes only what needs it and round-trips", () => {
  expect(formatValueList(["1", "New York", "paid"])).toBe("1, New York, paid");
  const tricky = ["a, b", "O'Brien", 'say "hi"', " padded ", "", "'lead"];
  expect(formatValueList(tricky)).toBe("'a, b', 'O''Brien', 'say \"hi\"', ' padded ', '', '''lead'");
  expect(ok(formatValueList(tricky))).toEqual(tricky);
});
