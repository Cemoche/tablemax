import { useEffect, useState } from "react";
import { toCsv, toInsert, toJson, toMarkdown, toTsv } from "../../lib/copyFormats";
import { effectiveShortcut } from "../../lib/keymap";
import { strings } from "../../lib/strings";
import { useSettings } from "../../stores/settings";
import type { CellValue, Dialect, ObjectRef } from "../../lib/types";
import type { GridModel } from "./editModel";
import { isTruncated } from "./editing";
import type { MenuItem } from "./GridContextMenu";
import type { CellBlock } from "./gridSelection";

/** The "Copy rows as" formats (Copy rows is TSV without a header, like Copy selected cells). */
export type CopyFormat = "tsv" | "csv" | "csvHeader" | "json" | "markdown" | "insert";
const FORMATS: readonly CopyFormat[] = ["tsv", "csv", "csvHeader", "json", "markdown", "insert"];
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

/** Text of `rows` in `format` (rows as the grid shows them; INSERT for `object` in `dialect`). */
function formatRows(
  format: CopyFormat,
  dialect: Dialect,
  object: ObjectRef,
  columns: string[],
  rows: CellValue[][],
): string {
  switch (format) {
    case "tsv":
      return toTsv(columns, rows, { header: false });
    case "csv":
      return toCsv(columns, rows, { header: false });
    case "csvHeader":
      return toCsv(columns, rows);
    case "json":
      return toJson(columns, rows);
    case "markdown":
      return toMarkdown(columns, rows);
    case "insert":
      return toInsert(dialect, object, columns, rows);
  }
}

/**
 * The grid menu's copy entries (Copy rows, Copy rows as …, Copy selected cells), Copy
 * selected cells for its key, and what the last copy has to say (inline, for NOTICE_MS).
 */
export function useSelectionCopy(model: GridModel | null, dialect: Dialect, object: ObjectRef) {
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const copyCellsKey = useSettings((s) => effectiveShortcut("grid.copyCells", s.settings.keymap));

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const write = (text: string, truncated: number, skipped: number) => {
    const notes = [
      ...(truncated > 0 ? [strings.grid.copyTruncated(truncated)] : []),
      ...(skipped > 0 ? [strings.grid.copySkippedInserts(skipped)] : []),
    ];
    setNotice(null);
    // Inside then(): a missing clipboard API rejects too.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setNotice(notes.length > 0 ? { error: false, text: notes.join(" ") } : null),
        (e: unknown) =>
          setNotice({ error: true, text: strings.grid.copyFailed(e instanceof Error ? e.message : String(e)) }),
      );
  };

  const copy = (format: CopyFormat, block: CellBlock) => {
    if (!model) return;
    const { columns, rows, skipped } = blockValues(model, block);
    // A display copy writes a truncated value's preview (INSERT skips its row, with a comment).
    const truncated = format === "insert" ? 0 : rows.flat().filter(isTruncated).length;
    write(formatRows(format, dialect, object, columns, rows), truncated, skipped);
  };

  /** Copy selected cells (grid.copyCells): the block's cells, tab-separated, no header. */
  const copyCells = (block: CellBlock) => {
    if (!model) return;
    const { columns, rows, skipped } = blockValues(model, block);
    write(toTsv(columns, rows, { header: false }), rows.flat().filter(isTruncated).length, skipped);
  };

  /** `block`: the selected cells; `shownCols`: the columns the grid shows, in order (whole rows). */
  const menuItems = (block: CellBlock, shownCols: number[]): MenuItem[] => {
    if (!model) return [];
    const rowsBlock: CellBlock = { rows: block.rows, cols: shownCols };
    const none = blockValues(model, rowsBlock).rows.length === 0;
    return [
      { label: strings.grid.menu.copyRows, disabled: none, onSelect: () => copy("tsv", rowsBlock) },
      { heading: strings.grid.menu.copyRowsAs },
      ...FORMATS.map(
        (f): MenuItem => ({
          label: strings.grid.copyAsText[f],
          ariaLabel: strings.grid.copyAs[f],
          indent: true,
          disabled: none,
          onSelect: () => copy(f, rowsBlock),
        }),
      ),
      {
        label: strings.grid.menu.copyCells,
        disabled: blockValues(model, block).rows.length === 0,
        shortcut: copyCellsKey,
        onSelect: () => copyCells(block),
      },
    ];
  };

  return { notice, menuItems, copyCells, dismiss: () => setNotice(null) };
}
