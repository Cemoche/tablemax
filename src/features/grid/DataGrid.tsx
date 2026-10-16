import {
  type GridCell,
  GridCellKind,
  type GridColumn,
  type Item,
  type Theme,
  DataEditor,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useMemo, useState } from "react";
import { strings } from "../../lib/strings";
import type { ResultSet, SortDir } from "../../lib/types";
import { cellContent } from "./cellContent";

const DEFAULT_COL_WIDTH = 160;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Builds Glide's canvas theme from the design tokens (no hardcoded colors). */
export function buildGridTheme(): Partial<Theme> {
  const font = cssVar("--font-ui");
  const size = cssVar("--text-md") || "13px";
  return {
    bgCell: cssVar("--surface"),
    bgCellMedium: cssVar("--surface"),
    bgHeader: cssVar("--surface-2"),
    bgHeaderHasFocus: cssVar("--surface-2"),
    bgHeaderHovered: cssVar("--surface-2"),
    bgBubble: cssVar("--surface-2"),
    textDark: cssVar("--text"),
    textMedium: cssVar("--text-muted"),
    textLight: cssVar("--text-muted"),
    textHeader: cssVar("--text"),
    textHeaderSelected: cssVar("--accent-contrast"),
    textBubble: cssVar("--text"),
    borderColor: cssVar("--border"),
    horizontalBorderColor: cssVar("--border"),
    drilldownBorder: cssVar("--border"),
    accentColor: cssVar("--accent"),
    accentFg: cssVar("--accent-contrast"),
    accentLight: cssVar("--surface-2"),
    linkColor: cssVar("--accent"),
    fontFamily: font,
    baseFontStyle: `${size}`,
    headerFontStyle: `600 ${size}`,
    editorFontSize: size,
  };
}

export interface DataGridProps {
  data: ResultSet;
  sort?: [string, SortDir] | null;
  onSort?: (column: string) => void;
}

/** Thin, read-only adapter over Glide Data Grid (canvas; not testable in jsdom). */
export function DataGrid({ data, sort = null, onSort }: DataGridProps) {
  const theme = useMemo(buildGridTheme, []);
  const mutedOverride = useMemo<Partial<Theme>>(() => ({ textDark: cssVar("--text-muted") }), []);
  const colKey = data.columns.map((c) => c.name).join("\u0000");
  const [widths, setWidths] = useState<{ key: string; w: Record<string, number> }>({
    key: colKey,
    w: {},
  });
  const colWidths = widths.key === colKey ? widths.w : {};

  const columns = useMemo<GridColumn[]>(
    () =>
      data.columns.map((c) => {
        const ind =
          sort && sort[0] === c.name
            ? ` ${sort[1] === "asc" ? strings.grid.sortAsc : strings.grid.sortDesc}`
            : "";
        return {
          id: c.name,
          title: c.name + ind,
          width: colWidths[c.name] ?? DEFAULT_COL_WIDTH,
        };
      }),
    [data.columns, sort, colWidths],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = data.rows[row]?.[col];
      if (!v) {
        return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false };
      }
      const c = cellContent(v);
      return {
        kind: GridCellKind.Text,
        data: c.copyText,
        displayData: c.display,
        copyData: c.copyText,
        allowOverlay: false,
        readonly: true,
        contentAlign: c.kind === "number" ? "right" : undefined,
        themeOverride: c.kind === "null" ? mutedOverride : undefined,
      };
    },
    [data.rows, mutedOverride],
  );

  return (
    <DataEditor
      width="100%"
      height="100%"
      columns={columns}
      rows={data.rows.length}
      getCellContent={getCellContent}
      getCellsForSelection={true}
      theme={theme}
      rowMarkers="number"
      smoothScrollX
      smoothScrollY
      onHeaderClicked={(col) => {
        const name = data.columns[col]?.name;
        if (name && onSort) onSort(name);
      }}
      onColumnResize={(col, newSize) =>
        setWidths({ key: colKey, w: { ...colWidths, [String(col.id)]: newSize } })
      }
    />
  );
}
