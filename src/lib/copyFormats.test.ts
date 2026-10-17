import { describe, expect, test } from "vitest";
import type { CellValue } from "./types";
import { toCsv, toInsert, toJson, toTsv } from "./copyFormats";

const T = (v: string): CellValue => ({ t: "text", v });
const N: CellValue = { t: "null" };
const cols = ["id", "name"];

describe("toCsv", () => {
  test("header, CRLF, quoting of comma, quote and newline, NULL empty", () => {
    const out = toCsv(cols, [
      [{ t: "int", v: 1 }, T('a,b "c"')],
      [{ t: "int", v: 2 }, T("l1\nl2")],
      [{ t: "int", v: 3 }, N],
      [{ t: "int", v: 4 }, T("cr\rx")],
    ]);
    expect(out).toBe('id,name\r\n1,"a,b ""c"""\r\n2,"l1\nl2"\r\n3,\r\n4,"cr\rx"');
  });
  test("quotes header names when needed", () => {
    expect(toCsv(["a,b", 'q"'], [])).toBe('"a,b","q"""');
  });
  test("empty rows give the header only", () => {
    expect(toCsv(cols, [])).toBe("id,name");
  });
  test("empty string is an empty field, same as NULL", () => {
    expect(toCsv(["a"], [[T("")]])).toBe("a\r\n");
  });
  test("truncated values use their preview", () => {
    expect(
      toCsv(["a", "b"], [
        [
          { t: "longText", v: { preview: "abc", len: 9999 } },
          { t: "bytes", v: { len: 4, hexPreview: "dead" } },
        ],
      ]),
    ).toBe("a,b\r\nabc,0xdead");
  });
  test("bool, bigInt, decimal, json, temporal", () => {
    expect(
      toCsv(["a", "b", "c", "d", "e"], [
        [
          { t: "bool", v: true },
          { t: "bigInt", v: "9007199254740993" },
          { t: "decimal", v: "1.50" },
          { t: "json", v: '{"a":1,"b":2}' },
          { t: "temporal", v: "2025-01-01" },
        ],
      ]),
    ).toBe('a,b,c,d,e\r\ntrue,9007199254740993,1.50,"{""a"":1,""b"":2}",2025-01-01');
  });
});

describe("toTsv", () => {
  test("tabs between fields, LF between lines, header first", () => {
    expect(toTsv(cols, [[{ t: "int", v: 1 }, T("x")], [{ t: "int", v: 2 }, N]])).toBe(
      "id\tname\n1\tx\n2\t",
    );
  });
  test("fields with tab, newline or quote are quoted Excel-style", () => {
    expect(toTsv(["a"], [[T("a\tb")], [T("l1\nl2")], [T('q"')]])).toBe(
      'a\n"a\tb"\n"l1\nl2"\n"q"""',
    );
  });
  test("short rows pad with empty fields", () => {
    expect(toTsv(["a", "b", "c"], [[T("1")]])).toBe("a\tb\tc\n1\t\t");
    expect(toCsv(["a", "b"], [[T("1")]])).toBe("a,b\r\n1,");
  });
  test("formula-looking values are copied as is", () => {
    expect(toCsv(["a"], [[T("=1+1")], [T("@x")]])).toBe("a\r\n=1+1\r\n@x");
  });
  test("commas are not special", () => {
    expect(toTsv(["a"], [[T("a,b")]])).toBe("a\na,b");
  });
  test("empty rows give the header only", () => {
    expect(toTsv(cols, [])).toBe("id\tname");
  });
});

describe("toJson", () => {
  test("array of objects with typed values", () => {
    const out = toJson(
      ["i", "f", "b", "big", "dec", "j", "n", "t", "ts"],
      [
        [
          { t: "int", v: 1 },
          { t: "float", v: 1.5 },
          { t: "bool", v: false },
          { t: "bigInt", v: "9007199254740993" },
          { t: "decimal", v: "1.10" },
          { t: "json", v: '{"a":[1,{"b":null}]}' },
          N,
          T("x"),
          { t: "temporal", v: "2025-01-01T00:00:00Z" },
        ],
      ],
    );
    expect(JSON.parse(out)).toEqual([
      {
        i: 1,
        f: 1.5,
        b: false,
        big: "9007199254740993",
        dec: "1.10",
        j: { a: [1, { b: null }] },
        n: null,
        t: "x",
        ts: "2025-01-01T00:00:00Z",
      },
    ]);
    expect(out).toContain('\n  {\n    "i": 1');
  });
  test("json cells keep their exact number text", () => {
    const out = toJson(["j"], [[{ t: "json", v: '{ "id": 9007199254740993,\n "d": 1.10, "s": "a b" }' }]]);
    expect(out).toBe('[\n  {\n    "j": {"id":9007199254740993,"d":1.10,"s":"a b"}\n  }\n]');
    expect(JSON.parse(out)).toHaveLength(1);
  });
  test("a __proto__ column is a normal key", () => {
    const out = toJson(["__proto__", "x"], [[T("p"), { t: "int", v: 1 }]]);
    expect(out).toBe('[\n  {\n    "__proto__": "p",\n    "x": 1\n  }\n]');
  });
  test("duplicate column names: last value wins", () => {
    expect(JSON.parse(toJson(["a", "a"], [[T("1"), T("2")]]))).toEqual([{ a: "2" }]);
  });
  test("empty rows give []", () => {
    expect(toJson(cols, [])).toBe("[]");
  });
  test("invalid json text falls back to the string", () => {
    expect(JSON.parse(toJson(["j"], [[{ t: "json", v: "{oops" }]]))).toEqual([{ j: "{oops" }]);
  });
  test("truncated values use their preview", () => {
    expect(
      JSON.parse(toJson(["a", "b"], [[{ t: "longText", v: { preview: "ab", len: 50 } }, { t: "bytes", v: { len: 2, hexPreview: "0a0b" } }]])),
    ).toEqual([{ a: "ab", b: "0x0a0b" }]);
  });
  test("non-finite floats become strings, not null", () => {
    expect(JSON.parse(toJson(["f"], [[{ t: "float", v: NaN }]]))).toEqual([{ f: "NaN" }]);
  });
});

describe("toInsert", () => {
  const obj = { schema: "public", name: "t" };
  test("PostgreSQL: quoting, quote in value, NULL, bool, numbers", () => {
    const out = toInsert("postgres", obj, ['a"b', "n", "ok", "x"], [
      [T("it's"), N, { t: "bool", v: true }, { t: "int", v: -3 }],
      [T("2"), N, { t: "bool", v: false }, { t: "float", v: 1.5 }],
    ]);
    expect(out).toBe(
      `INSERT INTO "public"."t" ("a""b", "n", "ok", "x") VALUES ('it''s', NULL, TRUE, -3);\n` +
        `INSERT INTO "public"."t" ("a""b", "n", "ok", "x") VALUES ('2', NULL, FALSE, 1.5);`,
    );
  });
  test("MySQL: backticks and backslash doubling, hex bytes", () => {
    const out = toInsert("mySql", { schema: null, name: "we`ird" }, ["a`b", "c"], [
      [T("a\\b'c"), { t: "bytes", v: { len: 2, hexPreview: "00ff" } }],
    ]);
    expect(out).toBe("INSERT INTO `we``ird` (`a``b`, `c`) VALUES ('a\\\\b''c', X'00ff');");
  });
  test("SQLite: double quotes, bool as 1/0, X'' bytes", () => {
    const out = toInsert("sqlite", { schema: null, name: "t" }, ["a", "b", "c"], [
      [T("it's"), { t: "bool", v: true }, { t: "bytes", v: { len: 1, hexPreview: "ab" } }],
    ]);
    expect(out).toBe(`INSERT INTO "t" ("a", "b", "c") VALUES ('it''s', 1, X'ab');`);
  });
  test("PostgreSQL bytes use the \\x form", () => {
    expect(toInsert("postgres", { schema: null, name: "t" }, ["b"], [[{ t: "bytes", v: { len: 1, hexPreview: "ab" } }]])).toBe(
      `INSERT INTO "t" ("b") VALUES (E'\\\\xab');`,
    );
  });
  test("bigInt, decimal, json and temporal are quoted strings", () => {
    expect(
      toInsert("postgres", { schema: null, name: "t" }, ["a", "b", "c", "d"], [
        [{ t: "bigInt", v: "1" }, { t: "decimal", v: "2.5" }, { t: "json", v: '{"a":"x\'y"}' }, { t: "temporal", v: "2025-01-01" }],
      ]),
    ).toBe(`INSERT INTO "t" ("a", "b", "c", "d") VALUES ('1', '2.5', '{"a":"x''y"}', '2025-01-01');`);
  });
  test("a row with a truncated value is commented out, never partially emitted", () => {
    const out = toInsert("postgres", { schema: null, name: "t" }, ["a", "big"], [
      [T("1"), { t: "longText", v: { preview: "abc", len: 100 } }],
      [T("2"), { t: "bytes", v: { len: 4, hexPreview: "dead" } }],
      [T("3"), { t: "bytes", v: { len: 2, hexPreview: "dead" } }],
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe('-- truncated value in column "big": row 1 skipped');
    expect(lines[1]).toBe('-- truncated value in column "big": row 2 skipped');
    expect(lines[2]).toBe(`INSERT INTO "t" ("a", "big") VALUES ('3', E'\\\\xdead');`);
    expect(out).not.toContain("abc");
  });
  test("newlines in a column name cannot escape the comment", () => {
    const out = toInsert("sqlite", { schema: null, name: "t" }, ["a\nDROP TABLE t;--"], [
      [{ t: "longText", v: { preview: "x", len: 9 } }],
    ]);
    expect(out.split("\n")).toHaveLength(1);
    expect(out.startsWith("--")).toBe(true);
  });
  test("non-finite floats are quoted strings", () => {
    expect(toInsert("postgres", { schema: null, name: "t" }, ["f"], [[{ t: "float", v: Infinity }]])).toBe(
      `INSERT INTO "t" ("f") VALUES ('Infinity');`,
    );
  });
  test("empty rows give an empty string", () => {
    expect(toInsert("postgres", { schema: null, name: "t" }, cols, [])).toBe("");
  });
});
