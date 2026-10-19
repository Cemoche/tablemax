import type { Dialect } from "../../lib/types";
import { isComment, isPunct, tokenize, wordOf } from "./sqlLexer";

/** Leading keywords of a `WITH …` statement whose main part is not a SELECT. */
const NOT_SELECT = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE"]);
/** Locking clauses that start with FOR (the words after it). */
const FOR_LOCKS = [["UPDATE"], ["SHARE"], ["NO", "KEY", "UPDATE"], ["KEY", "SHARE"]];

/**
 * Adds `LIMIT <limit>` to a top-level `SELECT` (or `WITH … SELECT`) that has no
 * `LIMIT`/`FETCH`/`TOP` of its own, and returns every other statement unchanged.
 *
 * - The clause goes after the last token of code, so trailing comments and a final `;`
 *   stay where they are; before `OFFSET <value>` and before a locking clause
 *   (`FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE`, MySQL
 *   `LOCK IN SHARE MODE`) when there is one. Words of a qualified name (`t.offset`) are
 *   identifiers; a bare `OFFSET` without a value, or a locking clause before OFFSET,
 *   leaves the statement unchanged rather than risk invalid SQL.
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

  /** Do the words after token `i` spell `seq`? */
  const followedBy = (i: number, seq: string[]) => seq.every((w, k) => wordOf(sql, code[i + 1 + k]) === w);
  /** Can token `i` start an OFFSET value (number, parameter, parenthesised expression)? */
  const isValue = (i: number) => {
    const t = code[i];
    if (!t || i >= end) return false;
    if (t.kind === "number") return true;
    if (t.kind === "word" && sql[t.from] === "$") return true; // $1
    if (isPunct(sql, t, "?") || isPunct(sql, t, "(")) return true;
    return isPunct(sql, t, ":") && code[i + 1]?.kind === "word" && code[i + 1].from === t.to; // :name
  };

  let depth = 0;
  let inMain = first === "SELECT";
  let offsetAt: number | null = null;
  let lockAt: number | null = null;
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
    // Part of a qualified name (`t.offset`, `limit.x`): an identifier, never a clause.
    if (isPunct(sql, code[i - 1], ".") || isPunct(sql, code[i + 1], ".")) continue;
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
        // OFFSET is a plain identifier in MySQL and SQLite: without a value after it we
        // cannot tell a clause from a column, so leave the statement alone.
        if (!isValue(i + 1)) return sql;
        // A locking clause before OFFSET (`FOR UPDATE OFFSET 5`, PG): no single place
        // for LIMIT keeps both valid everywhere.
        if (lockAt !== null) return sql;
        offsetAt ??= i;
        break;
      case "FOR":
        if (FOR_LOCKS.some((seq) => followedBy(i, seq))) lockAt ??= i;
        break;
      case "LOCK":
        if (dialect === "mySql" && followedBy(i, ["IN", "SHARE", "MODE"])) lockAt ??= i;
        break;
    }
  }
  if (depth !== 0 || !inMain) return sql;

  const insertAt = offsetAt ?? lockAt;
  if (insertAt !== null) {
    const at = code[insertAt].from;
    return `${sql.slice(0, at)}LIMIT ${limit} ${sql.slice(at)}`;
  }
  const at = code[end - 1].to;
  return `${sql.slice(0, at)} LIMIT ${limit}${sql.slice(at)}`;
}
