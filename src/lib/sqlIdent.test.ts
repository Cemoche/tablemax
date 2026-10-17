import { expect, test } from "vitest";
import { qualifiedName, quoteIdent, quoteIdentIfNeeded } from "./sqlIdent";

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

test("quoteIdentIfNeeded leaves plain names bare and quotes the rest", () => {
  // PostgreSQL folds unquoted names to lower case: any upper-case letter needs quotes.
  expect(quoteIdentIfNeeded("postgres", "users")).toBe("users");
  expect(quoteIdentIfNeeded("postgres", "user_2")).toBe("user_2");
  expect(quoteIdentIfNeeded("postgres", "MyCol")).toBe('"MyCol"');
  expect(quoteIdentIfNeeded("mySql", "MyCol")).toBe("MyCol");
  expect(quoteIdentIfNeeded("sqlite", "MyCol")).toBe("MyCol");
  // Special characters, a leading digit, an empty name.
  expect(quoteIdentIfNeeded("postgres", "a b")).toBe('"a b"');
  expect(quoteIdentIfNeeded("mySql", "my table")).toBe("`my table`");
  expect(quoteIdentIfNeeded("sqlite", "a-b")).toBe('"a-b"');
  expect(quoteIdentIfNeeded("postgres", "1st")).toBe('"1st"');
  expect(quoteIdentIfNeeded("postgres", "été")).toBe('"été"');
  expect(quoteIdentIfNeeded("postgres", "")).toBe('""');
  expect(quoteIdentIfNeeded("postgres", 'a"b')).toBe('"a""b"');
  // Reserved words of the dialect, whatever their case.
  expect(quoteIdentIfNeeded("postgres", "order")).toBe('"order"');
  expect(quoteIdentIfNeeded("postgres", "user")).toBe('"user"');
  expect(quoteIdentIfNeeded("mySql", "select")).toBe("`select`");
  expect(quoteIdentIfNeeded("mySql", "Key")).toBe("`Key`");
  expect(quoteIdentIfNeeded("sqlite", "group")).toBe('"group"');
  // Non-reserved keywords stay bare.
  expect(quoteIdentIfNeeded("postgres", "name")).toBe("name");
  expect(quoteIdentIfNeeded("mySql", "status")).toBe("status");
  expect(quoteIdentIfNeeded("postgres", "key")).toBe("key");
});
