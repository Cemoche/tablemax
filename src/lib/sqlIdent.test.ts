import { expect, test } from "vitest";
import { qualifiedName, quoteIdent } from "./sqlIdent";

test("quoteIdent doubles the dialect's quote character", () => {
  expect(quoteIdent("postgres", 'we"ird')).toBe('"we""ird"');
  expect(quoteIdent("sqlite", 'we"ird')).toBe('"we""ird"');
  expect(quoteIdent("mySql", "we`ird")).toBe("`we``ird`");
  expect(quoteIdent("mySql", 'a"b')).toBe('`a"b`');
});

test("qualifiedName prefixes the schema, except SQLite main", () => {
  expect(qualifiedName("postgres", "pub lic", "t")).toBe('"pub lic"."t"');
  expect(qualifiedName("mySql", "db", "t")).toBe("`db`.`t`");
  expect(qualifiedName("sqlite", "main", "t")).toBe('"t"');
  expect(qualifiedName("sqlite", "aux", "t")).toBe('"aux"."t"');
  expect(qualifiedName("postgres", null, "t")).toBe('"t"');
});
