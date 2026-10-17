import type { Dialect } from "../../lib/types";

export type Statement = { text: string; from: number; to: number };

export interface SplitOptions {
  /** Delimiter in effect at the start of `sql` (MySQL `DELIMITER`); default `;`. */
  delimiter?: string;
}

/*
 * Compound statements and DELIMITER (Plan 4 Task 8):
 * - MySQL/MariaDB: a line `DELIMITER <x>` (case-insensitive, at the start of a line and
 *   of a statement) changes the delimiter like the mysql client does; the line itself is
 *   never sent. With a delimiter other than `;`, statements end at that delimiter only.
 * - With `;`, the body of a compound statement (`CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT
 *   … BEGIN … END`, MariaDB `BEGIN NOT ATOMIC … END`, SQLite `CREATE TRIGGER … BEGIN …
 *   END`, PostgreSQL `BEGIN ATOMIC … END`) is kept whole. The tracker below mirrors
 *   `Compound` in `src-tauri/src/driver/mysql.rs`, so what the splitter sends as one
 *   statement is what the MySQL driver accepts as one.
 * Dollar-quoted bodies in PostgreSQL are supported.
 */

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isTagStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isTagChar = (c: string) => /[A-Za-z0-9_\u0080-￿]/.test(c);
const isWordStart = (c: string) => /[A-Za-z0-9_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

type Tok = { kind: "word"; up: string } | { kind: "punct"; ch: string } | { kind: "lit" };
type Frame = "block" | "caseStmt" | "caseExpr";
type Kind = "routine" | "trigger" | "event";
type Phase = "start" | "afterCreate" | "header" | "beginNot" | "beginAtomic" | "body" | "done" | "plain";

const PLAIN_CREATE = new Set([
  "TABLE",
  "VIEW",
  "INDEX",
  "DATABASE",
  "SCHEMA",
  "USER",
  "ROLE",
  "SERVER",
  "TABLESPACE",
  "LOGFILE",
  "SEQUENCE",
  "PACKAGE",
  "RESOURCE",
]);

const isWord = (t: Tok | null, ...kws: string[]) => t?.kind === "word" && kws.includes(t.up);

/** Follows the compound statement the tokens belong to (see the header comment). */
class Compound {
  private phase: Phase = "start";
  private kind: Kind = "routine";
  private stack: Frame[] = [];
  private paren = 0;
  private paramsClosed = false;
  private sawRow = false;
  private sawDo = false;
  private stmtPos = false;
  private lastWordAtStmt = false;
  private curFirst: string | null = null;
  private inHandler = false;
  private handlerBegun = false;
  private pendingBegin = false;
  private pendingEnd = false;
  private prev: Tok | null = null;

  constructor(private readonly dialect: Dialect) {}

  private push(f: Frame) {
    this.stack.push(f);
  }

  /** Lenient (the server reports real errors): a mismatched END still closes. */
  private pop() {
    this.stack.pop();
    if (this.stack.length === 0) this.phase = "done";
  }

  private bodyBeginAllowed(): boolean {
    switch (this.kind) {
      case "routine":
        return this.paramsClosed;
      case "event":
        return this.sawDo;
      case "trigger":
        // SQLite triggers have no FOR EACH ROW requirement.
        return (this.sawRow || this.dialect !== "mySql") && !isWord(this.prev, "FOLLOWS", "PRECEDES", "TRIGGER", "ON", "OF");
    }
  }

  /** Resolves a pending BEGIN / END with the next token; true when it consumed it. */
  private resolve(tok: Tok | null): boolean {
    if (this.pendingBegin) {
      this.pendingBegin = false;
      if (tok?.kind === "punct" && tok.ch === ":") {
        this.stmtPos = true; // a label named begin
        return true;
      }
      this.push("block");
      this.stmtPos = true;
      return false;
    }
    if (this.pendingEnd) {
      this.pendingEnd = false;
      if (isWord(tok, "IF", "LOOP", "WHILE", "REPEAT")) return true;
      this.pop();
      return isWord(tok, "CASE");
    }
    return false;
  }

  feed(tok: Tok) {
    this.step(tok);
    this.prev = tok;
  }

  private step(tok: Tok) {
    switch (this.phase) {
      case "start":
        if (isWord(tok, "CREATE")) this.phase = "afterCreate";
        else if (isWord(tok, "BEGIN") && this.dialect === "mySql") this.phase = "beginNot";
        else this.phase = "plain";
        return;
      case "beginNot":
        this.phase = isWord(tok, "NOT") ? "beginAtomic" : "plain";
        return;
      case "beginAtomic":
        if (isWord(tok, "ATOMIC")) {
          this.phase = "body";
          this.push("block");
          this.stmtPos = true;
        } else this.phase = "plain";
        return;
      case "afterCreate":
        if (isWord(tok, "PROCEDURE", "FUNCTION")) this.enterHeader("routine");
        else if (isWord(tok, "TRIGGER")) this.enterHeader("trigger");
        else if (isWord(tok, "EVENT")) this.enterHeader("event");
        else if (tok.kind === "word" && PLAIN_CREATE.has(tok.up)) this.phase = "plain";
        return;
      case "header":
        if (tok.kind === "punct" && tok.ch === "(") this.paren++;
        else if (tok.kind === "punct" && tok.ch === ")") {
          this.paren--;
          if (this.paren === 0) this.paramsClosed = true;
        } else if (this.paren === 0 && isWord(tok, "ROW")) this.sawRow = true;
        else if (this.paren === 0 && isWord(tok, "DO")) this.sawDo = true;
        else if (this.paren === 0 && isWord(tok, "BEGIN") && this.bodyBeginAllowed()) {
          this.phase = "body";
          this.push("block");
          this.stmtPos = true;
        }
        return;
      case "body":
        return this.body(tok);
      default:
        return;
    }
  }

  private enterHeader(kind: Kind) {
    this.phase = "header";
    this.kind = kind;
  }

  private body(tok: Tok) {
    if (this.resolve(tok)) return;
    if (this.phase !== "body") return;
    const atStmt = this.stmtPos;
    this.stmtPos = false;
    if (tok.kind === "word" && atStmt) {
      this.curFirst = tok.up;
      this.inHandler = false;
      this.handlerBegun = false;
    }
    const top = this.stack[this.stack.length - 1];
    if (tok.kind === "word") {
      switch (tok.up) {
        case "BEGIN":
          if (atStmt) this.pendingBegin = true;
          else if (
            this.curFirst === "DECLARE" &&
            this.inHandler &&
            !this.handlerBegun &&
            !isWord(this.prev, "FOR") &&
            !(this.prev?.kind === "punct" && this.prev.ch === ",")
          ) {
            this.handlerBegun = true;
            this.push("block");
            this.stmtPos = true;
          }
          break;
        case "CASE":
          this.push(atStmt ? "caseStmt" : "caseExpr");
          break;
        case "END":
          this.pendingEnd = true;
          break;
        case "THEN":
          this.stmtPos =
            top === "caseStmt" || (top !== "caseExpr" && (this.curFirst === "IF" || this.curFirst === "ELSEIF"));
          break;
        case "ELSE":
        case "LOOP":
        case "REPEAT":
          this.stmtPos = atStmt;
          break;
        case "DO":
          this.stmtPos = this.curFirst === "WHILE" && top !== "caseExpr";
          break;
        case "HANDLER":
          if (this.curFirst === "DECLARE") this.inHandler = true;
          break;
      }
    } else if (tok.kind === "punct" && tok.ch === ":") {
      this.stmtPos = this.lastWordAtStmt;
    }
    this.lastWordAtStmt = tok.kind === "word" && atStmt;
  }

  /** A `;`: true when it is inside the compound body (not a statement end). */
  semi(): boolean {
    if (this.phase !== "body") return false;
    this.resolve({ kind: "punct", ch: ";" });
    if (this.phase !== "body") return false;
    this.stmtPos = true;
    this.curFirst = null;
    this.inHandler = false;
    this.handlerBegun = false;
    this.prev = { kind: "punct", ch: ";" };
    return true;
  }
}

const DELIMITER_LINE = /^delimiter[ \t]+(\S+)[^\n]*/i;

interface ScanResult {
  statements: Statement[];
  /** Delimiter in effect at the end of the scanned text. */
  delimiter: string;
}

function scan(sql: string, dialect: Dialect, initialDelimiter: string): ScanResult {
  const out: Statement[] = [];
  const mysql = dialect === "mySql";
  const pg = dialect === "postgres";
  const n = sql.length;
  let delimiter = mysql ? initialDelimiter : ";";
  let segStart = 0;
  let hasCode = false;
  let compound = new Compound(dialect);
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
    compound = new Compound(dialect);
  };

  const skipLine = (from: number) => {
    let j = from;
    while (j < n && sql[j] !== "\n") j++;
    return j;
  };

  /** Only whitespace between the previous newline (or the start) and `pos`. */
  const atLineStart = (pos: number) => {
    let j = pos - 1;
    while (j >= 0 && sql[j] !== "\n") {
      if (!isWs(sql[j])) return false;
      j--;
    }
    return true;
  };

  const feed = (tok: Tok) => {
    if (delimiter === ";") compound.feed(tok);
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (isWs(c)) {
      i++;
    } else if (delimiter !== ";" && sql.startsWith(delimiter, i)) {
      flush(i);
      i += delimiter.length;
      segStart = i;
    } else if (mysql && !hasCode && (c === "d" || c === "D") && atLineStart(i) && DELIMITER_LINE.test(sql.slice(i, skipLine(i)))) {
      const line = sql.slice(i, skipLine(i));
      const m = DELIMITER_LINE.exec(line) as RegExpExecArray;
      flush(i); // drops a comment-only segment before the command
      delimiter = m[1];
      i += line.length;
      segStart = i;
    } else if (c === ";") {
      if (delimiter === ";" && !compound.semi()) {
        flush(i);
        i++;
        segStart = i;
      } else {
        // Inside a compound body, or a plain character under another delimiter.
        hasCode = true;
        i++;
      }
    } else if (c === "-" && next === "-" && (!mysql || i + 2 >= n || isWs(sql[i + 2]))) {
      i = skipLine(i + 2);
    } else if (c === "#" && mysql) {
      i = skipLine(i + 1);
    } else if (c === "/" && next === "*") {
      // MySQL runs the body of `/*! ... */` and `/*M! ... */`: they are code.
      if (mysql && (sql[i + 2] === "!" || (sql[i + 2] === "M" && sql[i + 3] === "!"))) {
        hasCode = true;
      }
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
      feed({ kind: "lit" });
    } else if (c === "$" && pg && (i === 0 || (!isTagChar(sql[i - 1]) && sql[i - 1] !== "$"))) {
      hasCode = true;
      let j = i + 1;
      if (j < n && isTagStart(sql[j])) {
        while (j < n && isTagChar(sql[j])) j++;
      }
      if (sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        i = close === -1 ? n : close + tag.length;
        feed({ kind: "lit" });
      } else {
        i++;
        feed({ kind: "punct", ch: "$" });
      }
    } else if (isWordStart(c)) {
      hasCode = true;
      let j = i + 1;
      while (j < n && isWordChar(sql[j]) && !(delimiter !== ";" && sql.startsWith(delimiter, j))) j++;
      feed({ kind: "word", up: sql.slice(i, j).toUpperCase() });
      i = j;
    } else {
      hasCode = true;
      feed({ kind: "punct", ch: c });
      i++;
    }
  }
  flush(n);
  return { statements: out, delimiter };
}

/**
 * Splits a script into single statements on top-level delimiters (`;`, or the one set
 * by a MySQL `DELIMITER` line), skipping quoted strings/identifiers, comments,
 * (PostgreSQL) dollar-quoted bodies and the body of compound statements. Statements are
 * trimmed, lack their final delimiter, and empty or comment-only ones are dropped.
 * `from`/`to` are offsets into `sql` (to exclusive).
 */
export function splitStatements(sql: string, dialect: Dialect, opts: SplitOptions = {}): Statement[] {
  return scan(sql, dialect, opts.delimiter ?? ";").statements;
}

/** The delimiter in effect at `pos` (MySQL `DELIMITER`; always `;` elsewhere). */
export function delimiterAt(sql: string, pos: number, dialect: Dialect): string {
  if (dialect !== "mySql") return ";";
  return scan(sql.slice(0, pos), dialect, ";").delimiter;
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
