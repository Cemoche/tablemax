import { expect, test } from "vitest";
import { cellContent } from "./cellContent";

test("NULL and empty string are displayed differently", () => {
  const n = cellContent({ t: "null" });
  const e = cellContent({ t: "text", v: "" });
  expect(n).toMatchObject({ kind: "null", display: "NULL" });
  expect(e.display).toBe('""');
  expect(e.copyText).toBe("");
  expect(n.display).not.toBe(e.display);
});

test("bigInt and decimal keep exact digits", () => {
  expect(cellContent({ t: "bigInt", v: "18446744073709551615" }).display).toBe("18446744073709551615");
  const d = cellContent({ t: "decimal", v: "12345678901234567890.123456789" });
  expect(d.display).toBe("12345678901234567890.123456789");
  expect(d.copyText).toBe("12345678901234567890.123456789");
  expect(d.kind).toBe("number");
});

test("long text shows ellipsis but copies the preview", () => {
  const c = cellContent({ t: "longText", v: { preview: "abc", len: 99999 } });
  expect(c.display).toBe("abc…");
  expect(c.copyText).toBe("abc");
});

test("bytes, json, bool, numbers, temporal", () => {
  expect(cellContent({ t: "bytes", v: { len: 2, hexPreview: "00ff" } }).display).toBe("<binary 2 B> 00ff");
  expect(cellContent({ t: "json", v: '{\n  "a": 1,\n  "b": [1, 2]\n}' }).display).toBe('{ "a": 1, "b": [1, 2] }');
  expect(cellContent({ t: "bool", v: true })).toMatchObject({ kind: "boolean", display: "true" });
  expect(cellContent({ t: "int", v: 5 })).toMatchObject({ kind: "number", display: "5" });
  expect(cellContent({ t: "float", v: 1.5 })).toMatchObject({ kind: "number", display: "1.5" });
  expect(cellContent({ t: "temporal", v: "2024-01-02" }).kind).toBe("text");
});

test("multi-line text is shown on one line but copied intact", () => {
  const c = cellContent({ t: "text", v: "a\nb" });
  expect(c.display).toBe("a b");
  expect(c.copyText).toBe("a\nb");
});
