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
 * - With `;`, the body of a compound statement is kept whole: MySQL `CREATE PROCEDURE/
 *   FUNCTION/TRIGGER/EVENT` whose body is BEGIN … END, IF, CASE, LOOP, WHILE or REPEAT,
 *   MariaDB `BEGIN NOT ATOMIC … END`, SQLite `CREATE TRIGGER … BEGIN … END`, PostgreSQL
 *   `BEGIN ATOMIC … END`. For MySQL the `Compound` tracker below follows the same model
 *   as `Compound` in `src-tauri/src/driver/mysql.rs`, so what the splitter sends as one
 *   statement is what the MySQL driver accepts as one.
 * Dollar-quoted bodies in PostgreSQL are supported.
 */

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isTagStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isTagChar = (c: string) => /[A-Za-z0-9_\u0080-￿]/.test(c);
const isWordStart = (c: string) => /[A-Za-z0-9_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

type Tok = { kind: "word"; up: string } | { kind: "punct"; ch: string } | { kind: "lit" };
type Frame = "block" | "if" | "caseStmt" | "loop" | "while" | "repeat";
type Until = "then" | "do" | "when" | "endRepeat";
type Mode =
  | { m: "stmtStart" }
  | { m: "afterBegin" }
  | { m: "expectAtomic" }
  | { m: "pendingWord" }
  | { m: "label" }
  | { m: "ordinary" }
  | { m: "expr"; until: Until; depth: number }
  | { m: "endPending" }
  | { m: "endRepeatPending" }
  | { m: "afterClose"; labelAllowed: boolean }
  | { m: "declareStart" }
  | { m: "declareKind" }
  | { m: "declareFor" }
  | { m: "cond" }
  | { m: "condSqlstate"; valueSeen: boolean }
  | { m: "condNot" }
  | { m: "condDone" };
type Hdr =
  | { h: "name" }
  | { h: "params"; depth: number }
  | { h: "chars" }
  | { h: "returns" }
  | { h: "typeAfterName" }
  | { h: "typeParen"; depth: number }
  | { h: "typeName" }
  | { h: "characterSet" }
  | { h: "expectLit" }
  | { h: "expect"; now: string[]; then: string[] | null };
type Phase =
  | { p: "start" }
  | { p: "afterCreate" }
  | { p: "routine"; hdr: Hdr }
  | { p: "trigger"; seen: number } // MySQL: scanning for FOR EACH ROW (seen 3 = after ROW)
  | { p: "triggerOrder" } // after FOLLOWS / PRECEDES
  | { p: "triggerBodyNext" }
  | { p: "event"; afterDo: boolean }
  | { p: "pgHeader"; depth: number; paramsSeen: boolean; pendingBegin: boolean }
  | { p: "sqliteTrigger"; pendingBegin: boolean }
  | { p: "beginNot" }
  | { p: "beginAtomic" }
  | { p: "body" }
  | { p: "plain" };

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
const TYPE_MODS = ["UNSIGNED", "SIGNED", "ZEROFILL", "BINARY", "ASCII", "UNICODE", "BYTE"];
const CONTROL = ["END", "ELSE", "ELSEIF", "WHEN", "UNTIL", "THEN", "DO", "DECLARE"];
/** Statements a SQLite trigger body may start with. */
const SQLITE_TRIGGER_STMT = ["INSERT", "UPDATE", "DELETE", "REPLACE", "SELECT", "WITH"];

const isWord = (t: Tok | null, ...kws: string[]) => t?.kind === "word" && kws.includes(t.up);
const isPunct = (t: Tok, ch: string) => t.kind === "punct" && t.ch === ch;

/**
 * Follows the compound statement the tokens belong to, so that the `;` inside its body
 * are not statement ends. Same model as `Compound` in `src-tauri/src/driver/mysql.rs`
 * (keep them in step): a body starts at a defined position (after the routine
 * characteristics, `FOR EACH ROW [FOLLOWS|PRECEDES x]`, the event's `DO`); a construct
 * opens only at a statement start (BEGIN and END are not reserved: `select begin` is a
 * column) and only an END at a statement start closes the innermost one; words after
 * `.`, `@` or `@@` are identifiers. What the model does not understand stops the
 * tracking (`plain`): the remaining `;` split as usual, so a hidden statement is never
 * glued to a CREATE. PostgreSQL `BEGIN ATOMIC` and SQLite trigger bodies are simple:
 * plain statements up to an END at a statement start.
 */
class Compound {
  private phase: Phase = { p: "start" };
  private mode: Mode = { m: "stmtStart" };
  private stack: Frame[] = [];
  private afterIdentMarker = false;
  /** PostgreSQL / SQLite body: only END at a statement start matters. */
  private simple = false;

  constructor(private readonly dialect: Dialect) {}

  private refuse() {
    this.phase = { p: "plain" };
    this.stack = [];
  }

  private top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  feed(tok: Tok) {
    const ident = this.afterIdentMarker;
    this.afterIdentMarker = tok.kind === "punct" && (tok.ch === "." || tok.ch === "@");
    this.step(tok, ident);
  }

  private step(tok: Tok, ident: boolean) {
    const ph = this.phase;
    switch (ph.p) {
      case "start":
        if (isWord(tok, "CREATE")) this.phase = { p: "afterCreate" };
        else if (isWord(tok, "BEGIN") && this.dialect === "mySql") this.phase = { p: "beginNot" };
        else this.phase = { p: "plain" };
        return;
      case "beginNot":
        this.phase = isWord(tok, "NOT") ? { p: "beginAtomic" } : { p: "plain" };
        return;
      case "beginAtomic":
        if (isWord(tok, "ATOMIC")) {
          this.phase = { p: "body" };
          this.stack.push("block");
          this.mode = { m: "stmtStart" };
        } else this.phase = { p: "plain" };
        return;
      case "afterCreate":
        if (isWord(tok, "PROCEDURE", "FUNCTION")) {
          if (this.dialect === "mySql") this.phase = { p: "routine", hdr: { h: "name" } };
          else if (this.dialect === "postgres")
            this.phase = { p: "pgHeader", depth: 0, paramsSeen: false, pendingBegin: false };
          else this.phase = { p: "plain" };
        } else if (isWord(tok, "TRIGGER")) {
          if (this.dialect === "mySql") this.phase = { p: "trigger", seen: 0 };
          else if (this.dialect === "sqlite") this.phase = { p: "sqliteTrigger", pendingBegin: false };
          else this.phase = { p: "plain" };
        } else if (isWord(tok, "EVENT")) {
          this.phase = this.dialect === "mySql" ? { p: "event", afterDo: false } : { p: "plain" };
        } else if (tok.kind === "word" && PLAIN_CREATE.has(tok.up)) this.phase = { p: "plain" };
        return;
      case "routine":
        return this.routine(ph.hdr, tok);
      case "trigger":
        if (ph.seen === 3) {
          if (isWord(tok, "FOLLOWS", "PRECEDES")) this.phase = { p: "triggerOrder" };
          else this.startBody(tok);
        } else if (isWord(tok, ["FOR", "EACH", "ROW"][ph.seen])) this.phase = { p: "trigger", seen: ph.seen + 1 };
        else this.phase = { p: "trigger", seen: isWord(tok, "FOR") ? 1 : 0 };
        return;
      case "triggerOrder":
        if (tok.kind === "word" || tok.kind === "lit") this.phase = { p: "triggerBodyNext" };
        else this.refuse();
        return;
      case "triggerBodyNext":
        return this.startBody(tok);
      case "event":
        if (ph.afterDo) this.startBody(tok);
        else if (isWord(tok, "DO")) this.phase = { p: "event", afterDo: true };
        return;
      case "pgHeader":
        if (ph.pendingBegin && isWord(tok, "ATOMIC")) {
          this.simple = true;
          this.phase = { p: "body" };
          this.stack.push("block");
          this.mode = { m: "stmtStart" };
          return;
        }
        ph.pendingBegin = false;
        if (isPunct(tok, "(")) ph.depth++;
        else if (isPunct(tok, ")")) {
          ph.depth--;
          if (ph.depth === 0) ph.paramsSeen = true;
        } else if (ph.paramsSeen && ph.depth === 0 && !ident && isWord(tok, "BEGIN")) ph.pendingBegin = true;
        return;
      case "sqliteTrigger":
        if (ph.pendingBegin && isWord(tok, ...SQLITE_TRIGGER_STMT)) {
          this.simple = true;
          this.phase = { p: "body" };
          this.stack.push("block");
          this.mode = { m: "ordinary" };
          return;
        }
        ph.pendingBegin = !ident && isWord(tok, "BEGIN");
        return;
      case "body":
        return this.body(tok, ident);
      case "plain":
        return;
    }
  }

  private startBody(tok: Tok) {
    this.phase = { p: "body" };
    this.mode = { m: "stmtStart" };
    this.stmtStart(tok);
  }

  private routine(hdr: Hdr, tok: Tok) {
    const set = (h: Hdr) => (this.phase = { p: "routine", hdr: h });
    switch (hdr.h) {
      case "name":
        if (isPunct(tok, "(")) set({ h: "params", depth: 1 });
        return;
      case "params":
        if (isPunct(tok, "(")) set({ h: "params", depth: hdr.depth + 1 });
        else if (isPunct(tok, ")")) set(hdr.depth === 1 ? { h: "chars" } : { h: "params", depth: hdr.depth - 1 });
        return;
      case "returns":
        if (tok.kind === "word") set({ h: "typeAfterName" });
        else this.refuse();
        return;
      case "typeAfterName":
        if (isPunct(tok, "(")) set({ h: "typeParen", depth: 1 });
        else if (isWord(tok, "CHARSET", "COLLATE")) set({ h: "typeName" });
        else if (isWord(tok, "CHARACTER")) set({ h: "characterSet" });
        else if (!isWord(tok, ...TYPE_MODS)) this.chars(tok);
        return;
      case "typeParen":
        if (isPunct(tok, "(")) set({ h: "typeParen", depth: hdr.depth + 1 });
        else if (isPunct(tok, ")"))
          set(hdr.depth === 1 ? { h: "typeAfterName" } : { h: "typeParen", depth: hdr.depth - 1 });
        return;
      case "typeName":
        if (tok.kind === "word" || tok.kind === "lit") set({ h: "typeAfterName" });
        else this.refuse();
        return;
      case "characterSet":
        if (isWord(tok, "SET")) set({ h: "typeName" });
        else this.refuse();
        return;
      case "expectLit":
        if (tok.kind === "lit") set({ h: "chars" });
        else this.refuse();
        return;
      case "expect":
        if (!isWord(tok, ...hdr.now)) this.refuse();
        else set(hdr.then ? { h: "expect", now: hdr.then, then: null } : { h: "chars" });
        return;
      case "chars":
        return this.chars(tok);
    }
  }

  /** Routine characteristics; the first other token starts the body. */
  private chars(tok: Tok) {
    let next: Hdr;
    if (isWord(tok, "RETURNS")) next = { h: "returns" };
    else if (isWord(tok, "COMMENT")) next = { h: "expectLit" };
    else if (isWord(tok, "LANGUAGE", "CONTAINS", "NO")) next = { h: "expect", now: ["SQL"], then: null };
    else if (isWord(tok, "NOT")) next = { h: "expect", now: ["DETERMINISTIC"], then: null };
    else if (isWord(tok, "DETERMINISTIC")) next = { h: "chars" };
    else if (isWord(tok, "READS", "MODIFIES")) next = { h: "expect", now: ["SQL"], then: ["DATA"] };
    else if (isWord(tok, "SQL")) next = { h: "expect", now: ["SECURITY"], then: ["DEFINER", "INVOKER"] };
    else return this.startBody(tok);
    this.phase = { p: "routine", hdr: next };
  }

  /** A token at a statement start (an empty stack: the routine body itself). */
  private stmtStart(tok: Tok) {
    const root = this.stack.length === 0;
    if (tok.kind !== "word") {
      if (root) this.phase = { p: "plain" };
      else if (this.simple) this.mode = { m: "ordinary" };
      else this.refuse();
      return;
    }
    if (this.simple) {
      this.mode = tok.up === "END" ? { m: "endPending" } : { m: "ordinary" };
      return;
    }
    const top = this.top();
    const push = (f: Frame, mode: Mode) => {
      this.stack.push(f);
      this.mode = mode;
    };
    switch (tok.up) {
      case "BEGIN":
        return push("block", { m: "afterBegin" });
      case "IF":
        return push("if", { m: "expr", until: "then", depth: 0 });
      case "CASE":
        return push("caseStmt", { m: "expr", until: "when", depth: 0 });
      case "LOOP":
        return push("loop", { m: "stmtStart" });
      case "WHILE":
        return push("while", { m: "expr", until: "do", depth: 0 });
      case "REPEAT":
        return push("repeat", { m: "stmtStart" });
    }
    if (root) {
      // The body is a plain statement (or `label:` before a compound one).
      if (CONTROL.includes(tok.up)) this.phase = { p: "plain" };
      else this.mode = { m: "pendingWord" };
      return;
    }
    if (tok.up === "DECLARE") this.mode = { m: "declareStart" };
    else if (tok.up === "END") this.mode = { m: "endPending" };
    else if (tok.up === "ELSEIF" && top === "if") this.mode = { m: "expr", until: "then", depth: 0 };
    else if (tok.up === "ELSE" && (top === "if" || top === "caseStmt")) this.mode = { m: "stmtStart" };
    else if (tok.up === "WHEN" && top === "caseStmt") this.mode = { m: "expr", until: "then", depth: 0 };
    else if (tok.up === "UNTIL" && top === "repeat") this.mode = { m: "expr", until: "endRepeat", depth: 0 };
    else if (CONTROL.includes(tok.up)) this.refuse();
    else this.mode = { m: "pendingWord" };
  }

  private close(labelAllowed: boolean) {
    this.stack.pop();
    this.mode = { m: "afterClose", labelAllowed };
  }

  private body(tok: Tok, ident: boolean) {
    const md = this.mode;
    switch (md.m) {
      case "stmtStart":
        return this.stmtStart(tok);
      case "afterBegin":
        if (isPunct(tok, ":")) this.refuse();
        else if (isWord(tok, "NOT")) this.mode = { m: "expectAtomic" };
        else {
          this.mode = { m: "stmtStart" };
          this.stmtStart(tok);
        }
        return;
      case "expectAtomic":
        if (isWord(tok, "ATOMIC")) this.mode = { m: "stmtStart" };
        else this.refuse();
        return;
      case "pendingWord":
        if (isPunct(tok, ":")) this.mode = { m: "label" };
        else if (this.stack.length === 0) this.phase = { p: "plain" };
        else this.mode = { m: "ordinary" };
        return;
      case "label":
        if (isWord(tok, "BEGIN", "LOOP", "WHILE", "REPEAT")) this.stmtStart(tok);
        else this.refuse();
        return;
      case "ordinary":
        return;
      case "expr": {
        if (ident || tok.kind !== "word") return;
        const { until, depth } = md;
        if (tok.up === "CASE") this.mode = { m: "expr", until, depth: depth + 1 };
        else if (tok.up === "END") {
          if (depth > 0) this.mode = { m: "expr", until, depth: depth - 1 };
          else if (until === "endRepeat") this.mode = { m: "endRepeatPending" };
          else this.refuse();
        } else if (depth > 0) {
          // THEN / WHEN / ELSE of a CASE expression.
        } else if (tok.up === "THEN" && until === "then") this.mode = { m: "stmtStart" };
        else if (tok.up === "WHEN" && until === "when") this.mode = { m: "expr", until: "then", depth: 0 };
        else if (tok.up === "DO" && until === "do") this.mode = { m: "stmtStart" };
        else if (tok.up === "THEN" || tok.up === "WHEN" || tok.up === "DO") this.refuse();
        return;
      }
      case "endRepeatPending":
        if (isWord(tok, "REPEAT") && this.top() === "repeat") this.close(true);
        else this.refuse();
        return;
      case "endPending": {
        const top = this.top();
        if (this.simple) return this.refuse(); // PostgreSQL / SQLite: END ;
        const ok =
          top === "block"
            ? !isWord(tok, "IF", "CASE", "LOOP", "WHILE", "REPEAT")
            : top === "if"
              ? isWord(tok, "IF")
              : top === "caseStmt"
                ? isWord(tok, "CASE")
                : top === "loop"
                  ? isWord(tok, "LOOP")
                  : top === "while"
                    ? isWord(tok, "WHILE")
                    : false;
        if (!ok) return this.refuse();
        if (top === "block") {
          this.close(true);
          this.body(tok, ident); // `END label`
        } else this.close(top === "loop" || top === "while");
        return;
      }
      case "afterClose":
        if (md.labelAllowed && tok.kind === "word") this.mode = { m: "afterClose", labelAllowed: false };
        else this.refuse();
        return;
      case "declareStart":
        this.mode = isWord(tok, "CONTINUE", "EXIT", "UNDO") ? { m: "declareKind" } : { m: "ordinary" };
        return;
      case "declareKind":
        this.mode = isWord(tok, "HANDLER") ? { m: "declareFor" } : { m: "ordinary" };
        return;
      case "declareFor":
        if (isWord(tok, "FOR")) this.mode = { m: "cond" };
        else this.refuse();
        return;
      case "cond":
        if (isWord(tok, "SQLSTATE")) this.mode = { m: "condSqlstate", valueSeen: false };
        else if (isWord(tok, "NOT")) this.mode = { m: "condNot" };
        else if (tok.kind === "word") this.mode = { m: "condDone" };
        else this.refuse();
        return;
      case "condSqlstate":
        if (!md.valueSeen && isWord(tok, "VALUE")) this.mode = { m: "condSqlstate", valueSeen: true };
        else if (tok.kind === "lit") this.mode = { m: "condDone" };
        else this.refuse();
        return;
      case "condNot":
        if (isWord(tok, "FOUND")) this.mode = { m: "condDone" };
        else this.refuse();
        return;
      case "condDone":
        if (isPunct(tok, ",")) this.mode = { m: "cond" };
        else {
          this.mode = { m: "stmtStart" };
          this.stmtStart(tok); // the handler's statement
        }
        return;
    }
  }

  /** A `;`: true when it is inside the compound body (not a statement end). */
  semi(): boolean {
    if (this.phase.p !== "body") return false;
    this.afterIdentMarker = false;
    const empty = () => this.stack.length === 0;
    let inside: boolean;
    switch (this.mode.m) {
      case "stmtStart":
      case "afterBegin":
      case "afterClose":
        inside = !empty();
        break;
      case "pendingWord":
        if (empty()) {
          this.phase = { p: "plain" };
          return false;
        }
        inside = true;
        break;
      case "ordinary":
        inside = true;
        break;
      case "endPending":
        if (this.top() !== "block") {
          this.refuse();
          return false;
        }
        this.stack.pop();
        inside = !empty();
        break;
      default:
        this.refuse();
        return false;
    }
    this.mode = inside ? { m: "stmtStart" } : { m: "afterClose", labelAllowed: false };
    return inside;
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
