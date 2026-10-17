import type { Dialect } from "../../lib/types";

/*
 * A small SQL tokenizer shared by completion and auto-LIMIT. It follows the same rules as
 * `splitStatements` (quotes with doubling, MySQL backslash escapes and `#` comments,
 * nested block comments and dollar quotes in PostgreSQL) so that strings, quoted
 * identifiers and comments never confuse the callers. Whitespace is not a token.
 */

export type TokenKind =
  | "word" // bare identifier or keyword
  | "qident" // quoted identifier: "…" (PG, SQLite), `…` (MySQL, SQLite), […] (SQLite)
  | "string" // '…', E'…', $tag$…$tag$ (PG), "…" (MySQL)
  | "number"
  | "lineComment"
  | "blockComment"
  | "punct"; // any other single character (`.`, `,`, `(`, `)`, `;`…)

export interface Token {
  kind: TokenKind;
  /** Offsets into the source; `to` is exclusive. */
  from: number;
  to: number;
  /** False for a string, quoted identifier or block comment cut by the end of the text. */
  closed: boolean;
  /** MySQL `/*! … *\/` / `/*M! … *\/`: a comment the server executes. */
  executable?: boolean;
}

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isWordStart = (c: string) => /[A-Za-z_\u0080-\uffff]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

export function tokenize(sql: string, dialect: Dialect): Token[] {
  const out: Token[] = [];
  const mysql = dialect === "mySql";
  const pg = dialect === "postgres";
  const sqlite = dialect === "sqlite";
  const n = sql.length;
  let i = 0;

  const push = (kind: TokenKind, from: number, to: number, closed = true) => {
    out.push({ kind, from, to: Math.min(to, n), closed });
  };

  /** Scans a quoted run opened at `start` by `q`; doubled quotes stay inside. */
  const quoted = (start: number, q: string, backslash: boolean): [number, boolean] => {
    let j = start + 1;
    while (j < n) {
      const c = sql[j];
      if (backslash && c === "\\") {
        j += 2;
      } else if (c === q) {
        if (sql[j + 1] === q) j += 2;
        else return [j + 1, true];
      } else j++;
    }
    return [n, false];
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (isWs(c)) {
      i++;
    } else if (c === "-" && next === "-" && (!mysql || i + 2 >= n || isWs(sql[i + 2]))) {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      push("lineComment", i, j);
      i = j;
    } else if (c === "#" && mysql) {
      let j = i + 1;
      while (j < n && sql[j] !== "\n") j++;
      push("lineComment", i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      const executable = mysql && (sql[i + 2] === "!" || (sql[i + 2] === "M" && sql[i + 3] === "!"));
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else if (pg && sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else j++;
      }
      push("blockComment", i, j, depth === 0);
      if (executable) out[out.length - 1].executable = true;
      i = j;
    } else if (c === "'") {
      // PostgreSQL E'…' strings take backslash escapes; the E was read as a word.
      const prev = out[out.length - 1];
      const eString =
        pg && prev?.kind === "word" && prev.to === i && prev.to - prev.from === 1 && /[eE]/.test(sql[prev.from]);
      const [end, closed] = quoted(i, "'", mysql || eString);
      if (eString) {
        out.pop();
        push("string", i - 1, end, closed);
      } else push("string", i, end, closed);
      i = end;
    } else if (c === '"') {
      const [end, closed] = quoted(i, '"', mysql);
      push(mysql ? "string" : "qident", i, end, closed);
      i = end;
    } else if (c === "`") {
      const [end, closed] = quoted(i, "`", false);
      push("qident", i, end, closed);
      i = end;
    } else if (c === "[" && sqlite) {
      const close = sql.indexOf("]", i + 1);
      const end = close === -1 ? n : close + 1;
      push("qident", i, end, close !== -1);
      i = end;
    } else if (c === "$" && pg && (i === 0 || (!isWordChar(sql[i - 1]) && sql[i - 1] !== "$"))) {
      let j = i + 1;
      if (j < n && isWordStart(sql[j])) {
        while (j < n && /[A-Za-z0-9_\u0080-\uffff]/.test(sql[j])) j++;
      }
      if (sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        const end = close === -1 ? n : close + tag.length;
        push("string", i, end, close !== -1);
        i = end;
      } else {
        // `$1` parameter (or a stray `$`).
        let k = i + 1;
        while (k < n && isDigit(sql[k])) k++;
        push(k > i + 1 ? "word" : "punct", i, k > i + 1 ? k : i + 1);
        i = k > i + 1 ? k : i + 1;
      }
    } else if (isDigit(c) || (c === "." && isDigit(next ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      push("number", i, j);
      i = j;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j++;
      push("word", i, j);
      i = j;
    } else {
      push("punct", i, i + 1);
      i++;
    }
  }
  return out;
}

export const isComment = (t: Token) => t.kind === "lineComment" || t.kind === "blockComment";

/** Upper-cased text of a word token, else "". */
export const wordOf = (sql: string, t: Token | undefined): string =>
  t && t.kind === "word" ? sql.slice(t.from, t.to).toUpperCase() : "";

export const isPunct = (sql: string, t: Token | undefined, ch: string): boolean =>
  !!t && t.kind === "punct" && sql[t.from] === ch;

/**
 * The name an identifier token designates: a quoted identifier is unquoted (doubled quotes
 * collapsed), a bare word is returned as written. `quoted` tells callers whether to compare
 * exactly (quoted) or case-insensitively (bare).
 */
export function identName(sql: string, t: Token): { name: string; quoted: boolean } | null {
  if (t.kind === "word") return { name: sql.slice(t.from, t.to), quoted: false };
  if (t.kind !== "qident") return null;
  const q = sql[t.from];
  const body = sql.slice(t.from + 1, t.closed ? t.to - 1 : t.to);
  if (q === "[") return { name: body, quoted: true };
  return { name: body.split(q + q).join(q), quoted: true };
}
