import type { Dialect } from "../../lib/types";

export type Statement = { text: string; from: number; to: number };

/*
 * Known limitation (Plan 1): compound bodies (CREATE PROCEDURE ... BEGIN ...; ... END)
 * and the mysql-client `DELIMITER` command are not understood; the splitter would cut
 * them at the inner semicolons. Dollar-quoted bodies in PostgreSQL are supported.
 */

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isTagStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isTagChar = (c: string) => /[A-Za-z0-9_\u0080-￿]/.test(c);

/**
 * Splits a script into single statements on top-level semicolons, skipping quoted
 * strings/identifiers, comments and (PostgreSQL) dollar-quoted bodies. Statements are
 * trimmed, lack their final `;`, and empty or comment-only ones are dropped.
 * `from`/`to` are offsets into `sql` (to exclusive).
 */
export function splitStatements(sql: string, dialect: Dialect): Statement[] {
  const out: Statement[] = [];
  const mysql = dialect === "mySql";
  const pg = dialect === "postgres";
  const n = sql.length;
  let segStart = 0;
  let hasCode = false;
  let i = 0;

  const flush = (end: number) => {
    if (hasCode) {
      let a = segStart;
      let b = end;
      while (a < b && isWs(sql[a])) a++;
      while (b > a && isWs(sql[b - 1])) b--;
      if (b > a) out.push({ text: sql.slice(a, b), from: a, to: b });
    }
    hasCode = false;
  };

  const skipLine = (from: number) => {
    let j = from;
    while (j < n && sql[j] !== "\n") j++;
    return j;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (isWs(c)) {
      i++;
    } else if (c === ";") {
      flush(i);
      i++;
      segStart = i;
    } else if (c === "-" && next === "-" && (!mysql || i + 2 >= n || isWs(sql[i + 2]))) {
      i = skipLine(i + 2);
    } else if (c === "#" && mysql) {
      i = skipLine(i + 1);
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else if (pg && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else i++;
      }
    } else if (c === "'" || c === '"' || c === "`") {
      hasCode = true;
      i++;
      // Doubled quotes ('' "" ``) close and reopen, so they need no special case.
      while (i < n && sql[i] !== c) {
        i += mysql && sql[i] === "\\" && c !== "`" ? 2 : 1;
      }
      i++;
    } else if (c === "$" && pg && (i === 0 || !isTagChar(sql[i - 1]) && sql[i - 1] !== "$")) {
      hasCode = true;
      let j = i + 1;
      if (j < n && isTagStart(sql[j])) {
        while (j < n && isTagChar(sql[j])) j++;
      }
      if (sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        i = close === -1 ? n : close + tag.length;
      } else {
        i++;
      }
    } else {
      hasCode = true;
      i++;
    }
  }
  flush(n);
  return out;
}

/** The statement containing `cursor`, else the closest preceding one, else null. */
export function statementAt(stmts: Statement[], cursor: number): Statement | null {
  let prev: Statement | null = null;
  for (const s of stmts) {
    if (cursor >= s.from && cursor <= s.to) return s;
    if (s.to < cursor) prev = s;
  }
  return prev;
}
