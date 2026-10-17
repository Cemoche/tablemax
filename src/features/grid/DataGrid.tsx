import {
  type CellClickedEventArgs,
  type DrawCellCallback,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type Item,
  type ProvideEditorCallback,
  type ProvideEditorComponent,
  type TextCell,
  type Theme,
  DataEditor,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strings } from "../../lib/strings";
import type { ResultSet, SortDir } from "../../lib/types";
import { CellEditorOverlay } from "./CellEditorOverlay";
import { type CellContent, cellContent } from "./cellContent";
import type { GridModel } from "./editModel";
import { useGridTheme } from "./gridTheme";

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 28;

const DEFAULT_COL_WIDTH = 160;

/** Editing hooks of a table grid; row/col are display indexes of `model`. */
export interface GridEditing {
  model: GridModel;
  onEdit: (row: number, col: number, text: string) => void;
  /** Loads the whole value of a truncated cell before it is edited. */
  loadFull: (row: number, col: number) => Promise<string>;
  /** Right click; `col` null on the row marker; x/y in viewport pixels. */
  onContextMenu: (row: number, col: number | null, x: number, y: number) => void;
  /** Enter / double click, also on a read-only cell (to say why it is read-only). */
  onActivate: (row: number, col: number) => void;
  /** The cell editor opened (true) or closed (false). */
  onEditorOpen: (open: boolean) => void;
}

export interface DataGridProps {
  data: ResultSet;
  sort?: [string, SortDir] | null;
  onSort?: (column: string) => void;
  /** Header clicks request a (server-side) sort. Disable for ad-hoc query results. */
  sortable?: boolean;
  /** Table tabs: pending changes laid over `data`, editable cells. Absent = read-only. */
  editing?: GridEditing;
}

const DEFAULT_CONTENT: CellContent = { kind: "null", display: strings.grid.defaultText, copyText: "" };

/** Thin adapter over Glide Data Grid (canvas; not testable in jsdom). */
export function DataGrid({ data, sort = null, onSort, sortable = true, editing }: DataGridProps) {
  const { theme, muted: mutedOverride, edit: editThemes } = useGridTheme();
  const colKey = data.columns.map((c) => c.name).join("\u0000");
  const [widths, setWidths] = useState<{ key: string; w: Record<string, number> }>({
    key: colKey,
    w: {},
  });
  const colWidths = widths.key === colKey ? widths.w : {};
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** The cell last activated (Enter / double click): the one the editor opens on. */
  const activated = useRef<Item | null>(null);
  /** Cancels the open cell editor (set while one is open). */
  const closeEditor = useRef<(() => void) | null>(null);

  // New data (a reload) closes an open editor: its row index may now be another row.
  const shownData = useRef(data);
  useEffect(() => {
    if (shownData.current === data) return;
    shownData.current = data;
    closeEditor.current?.();
  }, [data]);

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

  const model = editing?.model;
  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      if (model) {
        const cell = model.cell(row, col);
        const c = cell.value === "default" ? DEFAULT_CONTENT : cellContent(cell.value);
        const rowInserted = model.rows[row]?.kind === "insert";
        const theme: Partial<Theme> | undefined =
          c.kind === "null" || (cell.edited && !rowInserted)
            ? {
                ...(c.kind === "null" ? mutedOverride : {}),
                ...(cell.edited && !rowInserted ? editThemes.edited : {}),
              }
            : undefined;
        return {
          kind: GridCellKind.Text,
          data: c.copyText,
          displayData: c.display,
          copyData: c.copyText,
          allowOverlay: cell.editable,
          readonly: !cell.editable,
          contentAlign: c.kind === "number" ? "right" : undefined,
          themeOverride: theme,
        };
      }
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
    [model, data.rows, mutedOverride, editThemes],
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      if (!model) return undefined;
      const r = model.rows[row];
      if (!r) return undefined;
      const base =
        r.kind === "insert" ? editThemes.inserted : r.deleted ? editThemes.deleted : undefined;
      return model.rowError(row) !== null ? { ...base, ...editThemes.failed } : base;
    },
    [model, editThemes],
  );

  // Rows to delete are struck through.
  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      const r = model?.rows[args.row];
      if (r?.kind !== "row" || !r.deleted) return;
      const { ctx, rect, theme: t } = args;
      const y = Math.round(rect.y + rect.height / 2) + 0.5;
      ctx.save();
      ctx.strokeStyle = t.textDark;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x + 4, y);
      ctx.lineTo(rect.x + rect.width - 4, y);
      ctx.stroke();
      ctx.restore();
    },
    [model],
  );

  // Stable (Glide re-creates the editor when this changes); reads the latest props by ref.
  const provideEditor = useCallback<ProvideEditorCallback<GridCell>>((cell) => {
    const ed = editingRef.current;
    if (!ed || cell.kind !== GridCellKind.Text) return undefined;
    const at = activated.current;
    const Editor: ProvideEditorComponent<GridCell> = (p) => {
      const value = p.value as TextCell;
      const finish = useRef(p.onFinishedEditing);
      finish.current = p.onFinishedEditing;
      // A typed character replaces the value: nothing to load then.
      const load =
        p.initialValue === undefined && at && ed.model.cell(at[1], at[0]).truncated
          ? () => ed.loadFull(at[1], at[0])
          : undefined;
      return (
        <CellEditorOverlay
          value={value.data}
          load={load}
          onChange={(text) => p.onChange({ ...value, data: text })}
          onMount={() => {
            closeEditor.current = () => finish.current(undefined);
            editingRef.current?.onEditorOpen(true);
            return () => {
              closeEditor.current = null;
              editingRef.current?.onEditorOpen(false);
            };
          }}
        />
      );
    };
    return { editor: Editor, disablePadding: true };
  }, []);

  return (
    <DataEditor
      width="100%"
      height="100%"
      columns={columns}
      rows={model ? model.rows.length : data.rows.length}
      getCellContent={getCellContent}
      getCellsForSelection={true}
      theme={theme}
      rowHeight={ROW_HEIGHT}
      headerHeight={HEADER_HEIGHT}
      rowMarkers="number"
      smoothScrollX
      smoothScrollY
      onHeaderClicked={(col) => {
        const name = data.columns[col]?.name;
        if (sortable && name && onSort) onSort(name);
      }}
      onColumnResize={(col, newSize) =>
        setWidths({ key: colKey, w: { ...colWidths, [String(col.id)]: newSize } })
      }
      {...(editing && {
        getRowThemeOverride,
        drawCell,
        provideEditor,
        // Delete would clear the selected cells to "": NULL/empty are explicit menu choices.
        onDelete: () => false,
        onCellActivated: ([col, row]: Item) => {
          activated.current = [col, row];
          editingRef.current?.onActivate(row, col);
        },
        onCellEdited: ([col, row]: Item, v: GridCell) => {
          if (v.kind === GridCellKind.Text) editingRef.current?.onEdit(row, col, v.data);
        },
        onCellContextMenu: ([col, row]: Item, e: CellClickedEventArgs) => {
          e.preventDefault();
          editingRef.current?.onContextMenu(
            row,
            col < 0 ? null : col,
            e.bounds.x + e.localEventX,
            e.bounds.y + e.localEventY,
          );
        },
      })}
    />
  );
}
