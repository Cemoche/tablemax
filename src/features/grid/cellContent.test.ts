import { expect, test } from "vitest";
import type { CellValue } from "../../lib/types";
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

test("an i64 beyond 2^53 parsed from the Rust wire JSON keeps its exact digits", () => {
  // Exact output of serde_json for int_value(i64::MAX) (value.rs tests).
  const max: CellValue = JSON.parse('{"t":"bigInt","v":"9223372036854775807"}');
  expect(cellContent(max)).toMatchObject({
    kind: "number",
    display: "9223372036854775807",
    copyText: "9223372036854775807",
  });
  const min: CellValue = JSON.parse('{"t":"bigInt","v":"-9223372036854775808"}');
  expect(cellContent(min).display).toBe("-9223372036854775808");
  // What the old Int encoding would have produced: a rounded JS number.
  expect(String(JSON.parse("9223372036854775807"))).not.toBe("9223372036854775807");
});
