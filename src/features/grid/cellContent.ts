import { strings } from "../../lib/strings";
import type { CellValue } from "../../lib/types";

export interface CellContent {
  kind: "text" | "number" | "boolean" | "null";
  display: string;
  copyText: string;
}

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ");

/** Pure mapping from a wire cell to what the grid shows and what Ctrl+C copies. */
export function cellContent(v: CellValue): CellContent {
  switch (v.t) {
    case "null":
      return { kind: "null", display: strings.grid.nullText, copyText: "" };
    case "bool":
      return { kind: "boolean", display: String(v.v), copyText: String(v.v) };
    case "int":
    case "float":
      return { kind: "number", display: String(v.v), copyText: String(v.v) };
    case "bigInt":
    case "decimal":
      return { kind: "number", display: v.v, copyText: v.v };
    case "text":
      return {
        kind: "text",
        display: v.v === "" ? strings.grid.emptyText : oneLine(v.v),
        copyText: v.v,
      };
    case "longText":
      return { kind: "text", display: oneLine(v.v.preview) + "…", copyText: v.v.preview };
    case "bytes": {
      const s = strings.grid.binary(v.v.len, v.v.hexPreview);
      return { kind: "text", display: s, copyText: s };
    }
    case "json": {
      const compact = v.v
        .split(/\r?\n/)
        .map((l) => l.trim())
        .join(" ");
      return { kind: "text", display: compact, copyText: v.v };
    }
    case "temporal":
      return { kind: "text", display: v.v, copyText: v.v };
  }
}
