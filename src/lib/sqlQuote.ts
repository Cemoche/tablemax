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

/** A text literal: `'` doubled everywhere; MySQL also doubles `\` (its default escape). */
export function quoteString(d: Dialect, s: string): string {
  const body = d === "mySql" ? s.split("\\").join("\\\\") : s;
  return `'${body.split("'").join("''")}'`;
}

/** A binary literal from lowercase/uppercase hex digits: `'\x…'` on PostgreSQL, `X'…'` elsewhere. */
export function bytesLiteral(d: Dialect, hex: string): string {
  return d === "postgres" ? `'\\x${hex}'` : `X'${hex}'`;
}
