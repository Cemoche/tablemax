import { describe, expect, test } from "vitest";
import { bytesLiteral, qualifiedName, quoteIdent, quoteString } from "./sqlQuote";

describe("quoteIdent", () => {
  test("PostgreSQL and SQLite use double quotes, doubled", () => {
    expect(quoteIdent("postgres", 'My "Table"')).toBe('"My ""Table"""');
    expect(quoteIdent("sqlite", "order")).toBe('"order"');
  });
  test("MySQL uses backticks, doubled; double quotes untouched", () => {
    expect(quoteIdent("mySql", "we`ird")).toBe("`we``ird`");
    expect(quoteIdent("mySql", 'a"b')).toBe('`a"b`');
  });
});

describe("qualifiedName", () => {
  test("includes the schema when present", () => {
    expect(qualifiedName("postgres", { schema: "public", name: "t" })).toBe('"public"."t"');
    expect(qualifiedName("mySql", { schema: "db", name: "t" })).toBe("`db`.`t`");
  });
  test("name only without a schema", () => {
    expect(qualifiedName("sqlite", { schema: null, name: "t" })).toBe('"t"');
  });
});

describe("quoteString", () => {
  test("doubles single quotes everywhere", () => {
    expect(quoteString("postgres", "it's")).toBe("'it''s'");
    expect(quoteString("sqlite", "it's")).toBe("'it''s'");
  });
  test("MySQL also doubles backslashes", () => {
    expect(quoteString("mySql", "a\\b'c")).toBe("'a\\\\b''c'");
    expect(quoteString("postgres", "a\\b")).toBe("'a\\b'");
  });
});

describe("bytesLiteral", () => {
  test("per dialect", () => {
    expect(bytesLiteral("postgres", "00ff")).toBe("'\\x00ff'");
    expect(bytesLiteral("mySql", "00ff")).toBe("X'00ff'");
    expect(bytesLiteral("sqlite", "00ff")).toBe("X'00ff'");
  });
});
