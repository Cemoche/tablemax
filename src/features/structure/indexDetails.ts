/** What the Index view shows beyond the index's name, columns and uniqueness. */
export interface IndexDetails {
  /** The access method (`USING btree` on PostgreSQL), else "". */
  type: string;
  /** The condition of a partial index (after its `WHERE`), else "". */
  condition: string;
}

/**
 * The access method and the condition read from an index's `CREATE INDEX` text (PostgreSQL
 * and SQLite give one; MySQL and SQLite's automatic indexes do not). Only words outside
 * quotes, identifiers (also SQLite's `[…]`), parentheses and comments count, so a column,
 * expression or comment saying "where" is never taken for the clause.
 */
export function indexDetails(definition: string | null): IndexDetails {
  if (!definition) return { type: "", condition: "" };
  // The definition with every quoted, bracketed, parenthesized or commented part blanked
  // (same length, so the positions found in it are the definition's).
  let masked = "";
  let depth = 0;
  /** The character that ends the current quote ('…', "…", `…`, SQLite's […]). */
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let i = 0; i < definition.length; i++) {
    const ch = definition[i];
    const next = definition[i + 1];
    if (comment === "line") {
      if (ch === "\n") comment = null;
      masked += " ";
    } else if (comment === "block") {
      if (ch === "*" && next === "/") {
        comment = null;
        masked += " ";
        i++;
      }
      masked += " ";
    } else if (quote) {
      if (ch === quote) quote = null;
      masked += " ";
    } else if (ch === "-" && next === "-") {
      comment = "line";
      masked += " ";
    } else if (ch === "/" && next === "*") {
      comment = "block";
      masked += "  ";
      i++;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      quote = ch === "[" ? "]" : ch;
      masked += " ";
    } else if (ch === "(") {
      depth++;
      masked += " ";
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      masked += " ";
    } else {
      masked += depth > 0 ? " " : ch;
    }
  }
  const using = /\bUSING\s+(\w+)/i.exec(masked);
  const where = /\bWHERE\b/i.exec(masked);
  return {
    type: using ? using[1] : "",
    condition: where ? definition.slice(where.index + where[0].length).trim() : "",
  };
}
