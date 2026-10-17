import type { Dialect } from "../../lib/types";
import { isComment, isPunct, tokenize, wordOf } from "./sqlLexer";

/** Leading keywords of a `WITH …` statement whose main part is not a SELECT. */
const NOT_SELECT = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE"]);
/** Second word of a locking clause: FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE. */
const LOCK_AFTER_FOR = new Set(["UPDATE", "SHARE", "NO", "KEY"]);

/**
 * Adds `LIMIT <limit>` to a top-level `SELECT` (or `WITH … SELECT`) that has no
 * `LIMIT`/`FETCH`/`TOP` of its own, and returns every other statement unchanged.
 *
 * - The clause goes after the last token of code, so trailing comments and a final `;`
 *   stay where they are; before `OFFSET` and before a locking clause (`FOR UPDATE`,
 *   `FOR SHARE`, MySQL `LOCK IN SHARE MODE`) when there is one.
 * - Only depth-0 clauses count: a LIMIT inside a subquery or a CTE body does not.
 * - `SELECT … INTO` is left alone, as is anything the scanner cannot vouch for
 *   (unterminated quote or comment, unbalanced parenthesis, several statements, MySQL
 *   executable comments).
 * `LIMIT n` is valid in PostgreSQL, MySQL/MariaDB and SQLite alike.
 */
export function applyAutoLimit(sql: string, dialect: Dialect, limit: number): string {
  const tokens = tokenize(sql, dialect);
  if (tokens.some((t) => !t.closed || t.executable)) return sql;
  const code = tokens.filter((t) => !isComment(t));
  let end = code.length;
  if (end > 0 && isPunct(sql, code[end - 1], ";")) end--;
  if (end === 0) return sql;

  const first = wordOf(sql, code[0]);
  if (first !== "SELECT" && first !== "WITH") return sql;

  let depth = 0;
  let inMain = first === "SELECT";
  let insertAt: number | null = null;
  for (let i = 0; i < end; i++) {
    const t = code[i];
    if (isPunct(sql, t, ";")) return sql;
    if (isPunct(sql, t, "(")) {
      depth++;
      continue;
    }
    if (isPunct(sql, t, ")")) {
      if (--depth < 0) return sql;
      continue;
    }
    if (depth !== 0 || t.kind !== "word") continue;
    const w = wordOf(sql, t);
    if (!inMain) {
      // Still in the WITH list: CTE bodies are in parentheses, so the first depth-0
      // statement keyword is the main statement.
      if (w === "SELECT") inMain = true;
      else if (NOT_SELECT.has(w)) return sql;
      continue;
    }
    switch (w) {
      case "LIMIT":
      case "FETCH":
      case "TOP":
      case "INTO":
        return sql;
      case "OFFSET":
        insertAt ??= i;
        break;
      case "FOR":
        if (LOCK_AFTER_FOR.has(wordOf(sql, code[i + 1]))) insertAt ??= i;
        break;
      case "LOCK":
        if (wordOf(sql, code[i + 1]) === "IN") insertAt ??= i;
        break;
    }
  }
  if (depth !== 0 || !inMain) return sql;

  if (insertAt !== null) {
    const at = code[insertAt].from;
    return `${sql.slice(0, at)}LIMIT ${limit} ${sql.slice(at)}`;
  }
  const at = code[end - 1].to;
  return `${sql.slice(0, at)} LIMIT ${limit}${sql.slice(at)}`;
}
