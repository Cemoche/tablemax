import type { Dialect } from "./types";

/** Always-quoted identifier for the dialect (closing quote character doubled). */
export function quoteIdent(dialect: Dialect, name: string): string {
  const q = dialect === "mySql" ? "`" : '"';
  return `${q}${name.split(q).join(q + q)}${q}`;
}

/** `schema.name` quoted for the dialect; SQLite's `main` schema is omitted. */
export function qualifiedName(dialect: Dialect, schema: string | null, name: string): string {
  const omit = schema === null || (dialect === "sqlite" && schema === "main");
  return omit ? quoteIdent(dialect, name) : `${quoteIdent(dialect, schema)}.${quoteIdent(dialect, name)}`;
}
