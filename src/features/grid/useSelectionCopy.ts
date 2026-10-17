import { useEffect, useState } from "react";
import { toCsv, toInsert, toJson, toTsv } from "../../lib/copyFormats";
import { strings } from "../../lib/strings";
import type { CellValue, Dialect, ObjectRef } from "../../lib/types";
import type { GridModel } from "./editModel";
import type { MenuItem } from "./GridContextMenu";
import type { CellBlock } from "./gridSelection";

export type CopyFormat = "tsv" | "csv" | "json" | "insert";
const FORMATS: readonly CopyFormat[] = ["tsv", "csv", "json", "insert"];
/** How long a copy notice stays (it can also be dismissed). */
export const NOTICE_MS = 6000;

/**
 * What a block shows: its columns and the values of its loaded rows, pending edits
 * applied. New rows (not committed yet) are left out and counted in `skipped`.
 */
export function blockValues(
  model: GridModel,
  block: CellBlock,
): { columns: string[]; rows: CellValue[][]; skipped: number } {
  const cols = block.cols.filter((c) => c < model.columns.length);
  const rows: CellValue[][] = [];
  let skipped = 0;
  for (const r of block.rows) {
    const row = model.rows[r];
    if (!row) continue;
    if (row.kind === "insert") {
      skipped++;
      continue;
    }
    rows.push(
      cols.map((c) => {
        const v = model.cell(r, c).value;
        return v === "default" ? { t: "null" } : v;
      }),
    );
  }
  return { columns: cols.map((c) => model.columns[c]), rows, skipped };
}

/** The grid menu's "Copy as …" entries, and what the last copy has to say (inline, for NOTICE_MS). */
export function useSelectionCopy(model: GridModel | null, dialect: Dialect, object: ObjectRef) {
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const copy = (format: CopyFormat, columns: string[], rows: CellValue[][], skipped: number) => {
    const text =
      format === "tsv"
        ? toTsv(columns, rows)
        : format === "csv"
          ? toCsv(columns, rows)
          : format === "json"
            ? toJson(columns, rows)
            : toInsert(dialect, object, columns, rows);
    setNotice(null);
    // Inside then(): a missing clipboard API rejects too.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setNotice(skipped > 0 ? { error: false, text: strings.grid.copySkippedInserts(skipped) } : null),
        (e: unknown) =>
          setNotice({ error: true, text: strings.grid.copyFailed(e instanceof Error ? e.message : String(e)) }),
      );
  };

  const menuItems = (block: CellBlock): MenuItem[] => {
    if (!model) return [];
    const { columns, rows, skipped } = blockValues(model, block);
    return FORMATS.map((f) => ({
      label: strings.grid.copyAs[f],
      disabled: rows.length === 0,
      onSelect: () => copy(f, columns, rows, skipped),
    }));
  };

  return { notice, menuItems, dismiss: () => setNotice(null) };
}
