import { bytesLiteral, qualifiedObject, quoteIdent, quoteString } from "./sqlIdent";
import type { CellValue, Dialect, ObjectRef } from "./types";

// Copy formats for a grid selection. TSV/CSV/JSON are display copies: a truncated value
// (longText, partial bytes) is emitted as its preview. INSERT never emits a partial value.

/** A bytes value is complete only when its hex preview covers every byte. */
const bytesComplete = (v: { len: number; hexPreview: string }) => v.hexPreview.length === v.len * 2;

const isTruncated = (c: CellValue) =>
  c.t === "longText" || (c.t === "bytes" && !bytesComplete(c.v));

/** Text of a cell for TSV/CSV/JSON: NULL empty, truncated values as their preview, bytes as `0x<hex>`. */
function cellCopyText(c: CellValue): string {
  switch (c.t) {
    case "null":
      return "";
    case "bool":
    case "int":
    case "float":
      return String(c.v);
    case "longText":
      return c.v.preview;
    case "bytes":
      return `0x${c.v.hexPreview}`;
    default:
      return c.v;
  }
}

/** Options of the delimited copies. */
export interface DelimitedOptions {
  /** A first line with the column names (default true). */
  header?: boolean;
}

function delimited(
  columns: string[],
  rows: CellValue[][],
  sep: string,
  eol: string,
  needsQuote: RegExp,
  { header = true }: DelimitedOptions = {},
): string {
  const field = (s: string) => (needsQuote.test(s) ? `"${s.split('"').join('""')}"` : s);
  const lines = header ? [columns.map(field).join(sep)] : [];
  for (const row of rows) {
    // Iterate over the columns: a short row pads with empty fields.
    lines.push(columns.map((_, i) => field(row[i] ? cellCopyText(row[i]) : "")).join(sep));
  }
  return lines.join(eol);
}

/**
 * Header row then one line per row, tab-separated, LF line endings, no trailing newline.
 * Fields with a tab, CR, LF or `"` are quoted with doubled quotes (spreadsheet convention).
 * This is a raw data copy, not a spreadsheet-safe export: values starting with `= + - @` are
 * NOT neutralised, because a database client must copy the data exactly as stored.
 */
export function toTsv(columns: string[], rows: CellValue[][], opts?: DelimitedOptions): string {
  return delimited(columns, rows, "\t", "\n", /[\t\r\n"]/, opts);
}

/**
 * RFC 4180: header row, CRLF line endings, no trailing line break; fields with `,`, `"`, CR
 * or LF are quoted with doubled quotes; NULL and the empty string are both an empty field.
 * Raw data copy, not a spreadsheet-safe export: values starting with `= + - @` are NOT
 * neutralised (formula injection), because a database client must copy data exactly.
 */
export function toCsv(columns: string[], rows: CellValue[][], opts?: DelimitedOptions): string {
  return delimited(columns, rows, ",", "\r\n", /[,"\r\n]/, opts);
}

/** A Markdown table cell: `\` then `|` escaped (so `\|` cannot end as an unescaped pipe), line breaks as `<br>`. */
const mdCell = (s: string) =>
  s.split("\\").join("\\\\").split("|").join("\\|").replace(/\r\n|\r|\n/g, "<br>");

/**
 * A GitHub-flavoured Markdown table: the header, a `---` line, one line per row. NULL is
 * written `NULL` (a reader cannot tell an empty cell from it otherwise), the empty string
 * an empty cell; truncated values as their preview. No columns give "".
 */
export function toMarkdown(columns: string[], rows: CellValue[][]): string {
  if (columns.length === 0) return "";
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const out = [line(columns.map(mdCell)), line(columns.map(() => "---"))];
  for (const row of rows) {
    out.push(line(columns.map((_, i) => (row[i]?.t === "null" ? "NULL" : mdCell(row[i] ? cellCopyText(row[i]) : "")))));
  }
  return out.join("\n");
}

/** Drops the whitespace outside strings of valid JSON text (keeps number text untouched). */
function compactJson(t: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += t[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (!/\s/.test(c)) out += c;
  }
  return out;
}

/** JSON text of one cell. A json cell's own text is spliced in (after validation) so big
 * integers and trailing zeros survive; invalid json falls back to a JSON string. */
function jsonText(c: CellValue): string {
  switch (c.t) {
    case "null":
      return "null";
    case "bool":
      return String(c.v);
    case "int":
    case "float":
      // JSON has no NaN/Infinity: keep them as text rather than a silent null.
      return Number.isFinite(c.v) ? String(c.v) : JSON.stringify(String(c.v));
    case "json":
      try {
        JSON.parse(c.v);
        return compactJson(c.v);
      } catch {
        return JSON.stringify(c.v);
      }
    default:
      return JSON.stringify(cellCopyText(c)); // bigInt/decimal/text/temporal as strings; truncated as preview
  }
}

/**
 * Array of objects keyed by column name, 2-space indent (a json cell is spliced in compact).
 * bigInt/decimal stay strings, json keeps its exact text (no number rounding), NULL is null.
 * Built by hand, so a column named `__proto__` is a normal key. With duplicate column names
 * the last value wins, at the first one's position.
 */
export function toJson(columns: string[], rows: CellValue[][]): string {
  if (rows.length === 0) return "[]";
  const items = rows.map((row) => {
    const entries = new Map<string, string>();
    columns.forEach((name, i) => entries.set(name, jsonText(row[i] ?? { t: "null" })));
    if (entries.size === 0) return "  {}";
    const body = [...entries].map(([k, v]) => `    ${JSON.stringify(k)}: ${v}`);
    return `  {\n${body.join(",\n")}\n  }`;
  });
  return `[\n${items.join(",\n")}\n]`;
}

/**
 * SQL literal of a complete cell. Booleans: TRUE/FALSE, but 1/0 on SQLite (portable to old
 * versions). Strings: see quoteString (MySQL NO_BACKSLASH_ESCAPES caveat applies to the script).
 */
function sqlLiteral(d: Dialect, c: CellValue): string {
  switch (c.t) {
    case "null":
      return "NULL";
    case "bool":
      return d === "sqlite" ? (c.v ? "1" : "0") : c.v ? "TRUE" : "FALSE";
    case "int":
    case "float":
      return Number.isFinite(c.v) ? String(c.v) : quoteString(d, String(c.v));
    case "bytes":
      return bytesLiteral(d, c.v.hexPreview);
    case "text":
    case "bigInt":
    case "decimal":
    case "json":
    case "temporal":
      return quoteString(d, c.v);
    case "longText":
      return quoteString(d, c.v.preview); // unreachable: truncated rows are skipped
  }
}

/**
 * One `INSERT INTO <object> (<columns>) VALUES (…);` per row, joined by LF.
 * A row holding a truncated value (longText, or bytes whose hex preview is partial) is not
 * emitted: a comment line `-- truncated value in column "<name>": row N skipped` (N is
 * 1-based) takes its place, so the script can never insert a partial value. Empty rows or
 * no columns give "".
 */
export function toInsert(
  dialect: Dialect,
  object: ObjectRef,
  columns: string[],
  rows: CellValue[][],
): string {
  if (columns.length === 0) return "";
  const head = `INSERT INTO ${qualifiedObject(dialect, object)} (${columns
    .map((c) => quoteIdent(dialect, c))
    .join(", ")}) VALUES (`;
  return rows
    .map((row, n) => {
      const cells = columns.map((_, i) => row[i] ?? ({ t: "null" } as CellValue));
      const bad = cells.findIndex(isTruncated);
      if (bad >= 0) {
        const name = columns[bad].replace(/[\r\n]+/g, " ");
        return `-- truncated value in column "${name}": row ${n + 1} skipped`;
      }
      return `${head}${cells.map((c) => sqlLiteral(dialect, c)).join(", ")});`;
    })
    .join("\n");
}
