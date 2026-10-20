import { strings } from "../../lib/strings";
import type { CellValue } from "../../lib/types";

export interface CellContent {
  kind: "text" | "number" | "boolean" | "null";
  display: string;
  copyText: string;
  /** NULL, EMPTY or DEFAULT: drawn as a dim, smaller placeholder, not as a value. */
  placeholder: boolean;
}

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ");

const value = (kind: CellContent["kind"], display: string, copyText: string): CellContent => ({
  kind,
  display,
  copyText,
  placeholder: false,
});

/**
 * Pure mapping from a wire cell (or "default", the DEFAULT of a new row) to what the grid
 * shows and what Ctrl+C copies.
 */
export function cellContent(v: CellValue | "default"): CellContent {
  if (v === "default") return { kind: "null", display: strings.grid.defaultText, copyText: "", placeholder: true };
  switch (v.t) {
    case "null":
      return { kind: "null", display: strings.grid.nullText, copyText: "", placeholder: true };
    case "bool":
      return value("boolean", String(v.v), String(v.v));
    case "int":
    case "float":
      return value("number", String(v.v), String(v.v));
    case "bigInt":
    case "decimal":
      return value("number", v.v, v.v);
    case "text":
      return v.v === ""
        ? { kind: "text", display: strings.grid.emptyText, copyText: "", placeholder: true }
        : value("text", oneLine(v.v), v.v);
    case "longText":
      return value("text", oneLine(v.v.preview) + "…", v.v.preview);
    case "bytes": {
      const s = strings.grid.binary(v.v.len, v.v.hexPreview);
      return value("text", s, s);
    }
    case "json": {
      const compact = v.v
        .split(/\r?\n/)
        .map((l) => l.trim())
        .join(" ");
      return value("text", compact, v.v);
    }
    case "temporal":
      return value("text", v.v, v.v);
  }
}
