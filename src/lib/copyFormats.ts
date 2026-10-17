import { cellContent } from "../features/grid/cellContent";
import { bytesLiteral, qualifiedName, quoteIdent, quoteString } from "./sqlQuote";
import type { CellValue, Dialect, ObjectRef } from "./types";

// Copy formats for a grid selection. TSV/CSV/JSON are display copies: a truncated value
// (longText, partial bytes) is emitted as its preview. INSERT never emits a partial value.

/** A bytes value is complete only when its hex preview covers every byte. */
const bytesComplete = (v: { len: number; hexPreview: string }) => v.hexPreview.length === v.len * 2;

const isTruncated = (c: CellValue) =>
  c.t === "longText" || (c.t === "bytes" && !bytesComplete(c.v));

/** Text of a cell for TSV/CSV: the grid's copy text (NULL empty), bytes as `0x<hex>`. */
function cellText(c: CellValue): string {
  return c.t === "bytes" ? `0x${c.v.hexPreview}` : cellContent(c).copyText;
}

function delimited(
  columns: string[],
  rows: CellValue[][],
  sep: string,
  eol: string,
  needsQuote: RegExp,
): string {
  const field = (s: string) => (needsQuote.test(s) ? `"${s.split('"').join('""')}"` : s);
  const lines = [columns.map(field).join(sep)];
  for (const row of rows) lines.push(row.map((c) => field(cellText(c))).join(sep));
  return lines.join(eol);
}

/**
 * Header row then one line per row, tab-separated, LF line endings, no trailing newline.
 * Fields with a tab, CR, LF or `"` are quoted with doubled quotes (spreadsheet convention).
 */
export function toTsv(columns: string[], rows: CellValue[][]): string {
  return delimited(columns, rows, "\t", "\n", /[\t\r\n"]/);
}

/**
 * RFC 4180: header row, CRLF line endings, no trailing line break; fields with `,`, `"`, CR
 * or LF are quoted with doubled quotes; NULL and the empty string are both an empty field.
 */
export function toCsv(columns: string[], rows: CellValue[][]): string {
  return delimited(columns, rows, ",", "\r\n", /[,"\r\n]/);
}

function jsonValue(c: CellValue): unknown {
  switch (c.t) {
    case "null":
      return null;
    case "bool":
      return c.v;
    case "int":
    case "float":
      // JSON has no NaN/Infinity: keep them as text rather than a silent null.
      return Number.isFinite(c.v) ? c.v : String(c.v);
    case "json":
      try {
        return JSON.parse(c.v);
      } catch {
        return c.v; // not valid JSON (e.g. truncated by the server): keep the text
      }
    default:
      return cellText(c); // bigInt/decimal/text/temporal as strings; truncated ones as preview
  }
}

/**
 * Array of objects keyed by column name, pretty-printed with 2 spaces. bigInt/decimal stay
 * strings (no precision loss), json is parsed, NULL is null. With duplicate column names the
 * last one wins.
 */
export function toJson(columns: string[], rows: CellValue[][]): string {
  const out = rows.map((row) => {
    const o: Record<string, unknown> = {};
    columns.forEach((name, i) => {
      o[name] = jsonValue(row[i] ?? { t: "null" });
    });
    return o;
  });
  return JSON.stringify(out, null, 2);
}

/** SQL literal of a complete cell. Booleans: TRUE/FALSE, but 1/0 on SQLite (portable to old versions). */
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
  const head = `INSERT INTO ${qualifiedName(dialect, object)} (${columns
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
