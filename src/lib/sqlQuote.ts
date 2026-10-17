import type { Dialect, ObjectRef } from "./types";

// Mirrors src-tauri/src/driver/sql.rs (quote_ident, qualified) and the literal escaping of
// src-tauri/src/driver/dml.rs (render_preview). Keep them in sync.

/** `…` with `` doubled on MySQL; "…" with "" doubled on PostgreSQL and SQLite. */
export function quoteIdent(d: Dialect, ident: string): string {
  return d === "mySql"
    ? `\`${ident.split("`").join("``")}\``
    : `"${ident.split('"').join('""')}"`;
}

/** `schema.name`, or just `name` when the object has no schema. */
export function qualifiedName(d: Dialect, obj: ObjectRef): string {
  return obj.schema === null
    ? quoteIdent(d, obj.name)
    : `${quoteIdent(d, obj.schema)}.${quoteIdent(d, obj.name)}`;
}

/**
 * A text literal. `'` is doubled everywhere. PostgreSQL: a string with a backslash is
 * written `E'…'` with `\` doubled, so it reads the same whatever standard_conforming_strings
 * is; other strings stay `'…'`. MySQL doubles `\` (correct in the default sql_mode; under
 * NO_BACKSLASH_ESCAPES the doubled backslashes would be read literally). SQLite has no escapes.
 */
export function quoteString(d: Dialect, s: string): string {
  const q = s.split("'").join("''");
  if (d === "mySql") return `'${q.split("\\").join("\\\\")}'`;
  if (d === "postgres" && s.includes("\\")) return `E'${q.split("\\").join("\\\\")}'`;
  return `'${q}'`;
}

/** A binary literal from hex digits: `E'\\x…'` on PostgreSQL (mode-independent), `X'…'` elsewhere. */
export function bytesLiteral(d: Dialect, hex: string): string {
  return d === "postgres" ? `E'\\\\x${hex}'` : `X'${hex}'`;
}
