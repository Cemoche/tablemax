import {
  type CellClickedEventArgs,
  CompactSelection,
  type DrawCellCallback,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridKeyEventArgs,
  type GridSelection,
  type HeaderClickedEventArgs,
  type Item,
  type ProvideEditorCallback,
  type ProvideEditorComponent,
  type TextCell,
  type Theme,
  DataEditorCore,
  type DataEditorRef,
  ImageWindowLoaderImpl,
  sprites,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toTsv } from "../../lib/copyFormats";
import { type KeymapActionId, effectiveShortcuts } from "../../lib/keymap";
import { isModKey } from "../../lib/platform";
import { matchCombination, typesCharacter } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import type { CellValue, ResultSet, SortDir } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { useSettings } from "../../stores/settings";
import { CellEditorOverlay } from "./CellEditorOverlay";
import { type CellContent, cellContent } from "./cellContent";
import {
  type ColumnLayout,
  type ColumnMeasure,
  RESIZE_MAX,
  RESIZE_MIN,
  autoSizeColumns,
  fitColumn,
  moveColumn,
  reconcileLayout,
} from "./columnLayout";
import type { GridModel } from "./editModel";
import { GridContextMenu, type MenuItem } from "./GridContextMenu";
import {
  type CellBlock,
  highlightedRows,
  rowMarkerClick,
  selectedRowOf,
  selectionBlock,
  withSelectedRow,
} from "./gridSelection";
import { markerFontSize, useGridTheme } from "./gridTheme";
import { type RowNumberStyle, gridRenderers, rowNumberWidth } from "./rowNumbers";
import { QuickLook } from "./QuickLook";

/** Spec §5.2 at 100 %: rows 26 (they grow with a larger data font), header 30, numbers 46 (wider for long numbers: rowNumberWidth). */
const MIN_ROW_HEIGHT = 26;
const HEADER_HEIGHT = 30;

/** Editing hooks of a table grid; row/col are display rows and columns of `model` (its own column order). */
export interface GridEditing {
  model: GridModel;
  onEdit: (row: number, col: number, text: string) => void;
  /** Loads the whole value of a truncated cell before it is edited. */
  loadFull: (row: number, col: number) => Promise<string>;
  /**
   * Right click; `col` null on the row marker; x/y in viewport pixels; `selection` = the
   * cells selected at that moment (null: none).
   */
  onContextMenu: (row: number, col: number | null, x: number, y: number, selection?: CellBlock | null) => void;
  /** The cell is a foreign key value that links to a row (indicator, Mod+click). */
  linkAt: (row: number, col: number) => boolean;
  /** Opens the row the cell references (Mod+click). */
  onOpenLink: (row: number, col: number) => void;
  /** Activation (Alt+Enter, double click), also on a read-only cell (to say why it is read-only). */
  onActivate: (row: number, col: number) => void;
  /** The cell editor opened (true) or closed (false). */
  onEditorOpen: (open: boolean) => void;
  /** The selected row changed (the current cell's row; null when nothing is selected). */
  onSelect: (row: number | null) => void;
  /** Where the selected record is now (it moves with inserts, reloads and pages). */
  selectedRow: number | null;
  /**
   * Changes whenever display rows are added, removed or reloaded, or a commit locks them:
   * an open cell editor is then closed (its edit dropped).
   */
  rowSignature: string;
  /** The identity of a display row (stable across renders), null when out of range. */
  rowIdAt: (row: number) => string | null;
  /** Where the row with that identity is now (null: gone). */
  rowById: (id: string) => number | null;
}

/** A grid key acting on the selected rows. */
export type RowsAction = "delete" | "duplicate";

export interface DataGridProps {
  data: ResultSet;
  sort?: [string, SortDir] | null;
  onSort?: (column: string) => void;
  /** Header clicks request a (server-side) sort. Disable for ad-hoc query results. */
  sortable?: boolean;
  /** Table tabs: pending changes laid over `data`, editable cells. Absent = read-only. */
  editing?: GridEditing;
  /** Where the column widths, order and hidden columns are kept (gridViews); absent: in the grid only. */
  layoutKey?: string;
  /** Header menu: sort the column one way (null removes the sort). */
  onSortTo?: (column: string, dir: SortDir | null) => void;
  /** Header menu: Filter with column. */
  onFilterColumn?: (column: string) => void;
  /** Space in the grid: show or hide the row details. */
  onToggleDetails?: () => void;
  /** Enter: Quick Look of a cell (the table's column). Absent: the grid shows it itself. */
  onQuickLook?: (row: number, col: number) => void;
  /** Delete / grid.deleteRows and grid.duplicateRows on the selected rows. */
  onRowsAction?: (action: RowsAction, rows: number[]) => void;
  /** grid.copyCells (Ctrl+Shift+C) on the selected cells (the table's columns, as shown). Absent: copied here. */
  onCopyCells?: (block: CellBlock) => void;
  /** grid.previousPage / grid.nextPage (Ctrl+← / Ctrl+→): only while the grid has the focus. */
  onPageKey?: (dir: "previous" | "next") => void;
}

const EMPTY_SELECTION: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

// Key codes for Glide's hotkey syntax (`alt+_13`), which compares `keyCode`: a letter's
// keyCode is the letter the layout types (like our matching), the other keys' their position.
const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Space: 32,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PageUp: 33,
  PageDown: 34,
  ",": 188,
  ".": 190,
  "/": 191,
  ";": 186,
  "-": 189,
  "=": 187,
  "[": 219,
  "]": 221,
  "\\": 220,
  "`": 192,
};

/** A canonical spec ("Alt+Enter", "Mod+E") in Glide's hotkey syntax ("alt+_13", "primary+_69"). */
export function glideHotkey(spec: string): string {
  const parts = spec.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => (m === "Mod" ? "primary" : m.toLowerCase()));
  const fn = /^F(\d+)$/.exec(key);
  const code = fn ? 111 + Number(fn[1]) : /^[A-Z0-9]$/.test(key) ? key.charCodeAt(0) : KEY_CODES[key];
  return code === undefined ? "" : [...mods, `_${code}`].join("+");
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let measureCtx: Ctx | null | undefined;
function measureContext(): Ctx | null {
  if (measureCtx !== undefined) return measureCtx;
  try {
    if (typeof OffscreenCanvas !== "undefined") measureCtx = new OffscreenCanvas(1, 1).getContext("2d");
    else if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) measureCtx = null;
    else measureCtx = document.createElement("canvas").getContext("2d");
  } catch {
    measureCtx = null;
  }
  return measureCtx ?? null;
}

/** Text widths in the grid's fonts (estimates where no canvas can measure: tests). */
function columnMeasure(dataFont: string, headerFont: string, fontSize: number): ColumnMeasure {
  const ctx = measureContext();
  if (!ctx) return { text: (s) => s.length * fontSize * 0.6, header: (s) => s.length * 7.5 };
  return {
    text: (s) => {
      ctx.font = dataFont;
      return ctx.measureText(s).width;
    },
    header: (s) => {
      ctx.font = headerFont;
      return ctx.measureText(s).width;
    },
  };
}

/**
 * Unique keys of the result's columns (a query may return the same name twice): the name,
 * then `name␀index` for a repeated one. Layouts are stored by these keys.
 */
const columnKeys = (names: string[]) => names.map((n, i) => (names.indexOf(n) === i ? n : `${n}\u0000${i}`));

/** The column layout: in gridViews per table when `key` is given, else local to the grid. */
function useColumnLayout(key: string | undefined, columns: string[]) {
  const stored = useGridViews((s) => (key === undefined ? undefined : s.layouts[key]));
  const [local, setLocal] = useState<ColumnLayout | undefined>(undefined);
  const raw = key === undefined ? local : stored;
  const columnsKey = columns.join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => reconcileLayout(raw, columns), [raw, columnsKey]);
  const update = useCallback(
    (patch: Partial<ColumnLayout>) => {
      if (key !== undefined) useGridViews.getState().setLayout(key, patch);
      else setLocal((l) => ({ ...(l ?? { widths: {}, order: [], hidden: [] }), ...patch }));
    },
    [key],
  );
  /** Forgets one part of the layout (Reset positions: the order). */
  const reset = useCallback(
    (part: keyof ColumnLayout) => {
      if (key !== undefined) useGridViews.getState().resetLayout(key, part);
      else setLocal((l) => l && { ...l, [part]: part === "widths" ? {} : [] });
    },
    [key],
  );
  return { layout, update, reset };
}

/** Thin adapter over Glide Data Grid (canvas; not testable in jsdom). */
export function DataGrid({
  data,
  sort = null,
  onSort,
  sortable = true,
  editing,
  layoutKey,
  onSortTo,
  onFilterColumn,
  onToggleDetails,
  onQuickLook,
  onRowsAction,
  onCopyCells,
  onPageKey,
}: DataGridProps) {
  const g = useGridTheme();
  const { theme, muted: mutedOverride, edit: editThemes, rows: rowThemes, rowNumbers } = g;
  const keymap = useSettings((s) => s.settings.keymap);
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const names = useMemo(() => data.columns.map((c) => c.name), [data.columns]);
  const keys = useMemo(() => columnKeys(names), [names]);
  const { layout, update: updateLayout, reset: resetLayout } = useColumnLayout(layoutKey, keys);
  /** Data columns in display order (hidden ones left out). */
  const shownCols = useMemo(
    () => layout.order.filter((k) => !layout.hidden.includes(k)).map((k) => keys.indexOf(k)),
    [layout.order, layout.hidden, keys],
  );
  const shownRef = useRef(shownCols);
  shownRef.current = shownCols;
  /** The data column shown at display column `col`. */
  const dataCol = useCallback((col: number) => shownRef.current[col] ?? col, []);

  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** The cell last activated (Alt+Enter / double click): the one the editor opens on (display col). */
  const activated = useRef<Item | null>(null);
  /** Cancels the open cell editor (set while one is open). */
  const closeEditor = useRef<(() => void) | null>(null);
  /** The record and (data) column the open editor edits (captured when it opened). */
  const editorTarget = useRef<{ id: string | null; col: number } | null>(null);
  /** Controlled: reports the selected row and follows the selected record (table grids). */
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** Where Shift+click on a row number extends from. */
  const anchor = useRef<number | null>(null);
  const gridRef = useRef<DataEditorRef>(null);
  if (editing) {
    const moved = withSelectedRow(selection, editing.selectedRow);
    if (moved !== selection) setSelection(moved);
  }
  const [headerMenu, setHeaderMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [quickLook, setQuickLook] = useState<{ row: number; col: number } | null>(null);
  /** A column border is being dragged (Glide's resize start … end). */
  const resizing = useRef(false);

  // New data (a reload), rows added or removed, or a commit closes an open editor: its row
  // index may now be another row.
  const shown = useRef({ data, signature: editing?.rowSignature });
  const signature = editing?.rowSignature;
  useEffect(() => {
    if (shown.current.data === data && shown.current.signature === signature) return;
    shown.current = { data, signature };
    closeEditor.current?.();
  }, [data, signature]);

  // Widths from the loaded page (not its pending edits: the columns do not jump while typing),
  // measured again once the data font changed or loaded.
  const measure = useMemo(
    () => columnMeasure(`${theme.baseFontStyle} ${theme.fontFamily}`, g.header, g.fontSize),
    [theme, g.header, g.fontSize],
  );
  const textAt = useCallback(
    (row: number, col: number) => {
      const v = data.rows[row]?.[col];
      return v ? cellContent(v).display : "";
    },
    [data.rows],
  );
  const autoWidths = useMemo(
    () => autoSizeColumns(keys, data.rows.length, textAt, measure),
    [keys, data.rows.length, textAt, measure],
  );
  const fit = useCallback(
    (col: number) => fitColumn(keys[col], data.rows.length, (r) => textAt(r, col), measure),
    [keys, data.rows.length, textAt, measure],
  );

  const headerOverride = useMemo(() => ({ headerFontFull: g.header }) as Partial<Theme>, [g.header]);
  const columns = useMemo<GridColumn[]>(
    () =>
      shownCols.map((c) => {
        const name = names[c];
        const ind =
          sort && sort[0] === name ? ` ${sort[1] === "asc" ? strings.grid.sortAsc : strings.grid.sortDesc}` : "";
        return {
          id: keys[c],
          title: name + ind,
          width: layout.widths[keys[c]] ?? autoWidths[keys[c]],
          themeOverride: headerOverride,
        };
      }),
    [shownCols, names, keys, sort, layout.widths, autoWidths, headerOverride],
  );

  const highlighted = useMemo(() => highlightedRows(selection), [selection]);
  // Row numbers drawn by our marker renderer (right-aligned, interface font, #102); it reads
  // the selection and colours of the last render.
  const rowNumberStyle = useRef<RowNumberStyle>({ selected: () => false, family: "", selectedFill: "", selectedText: "" });
  rowNumberStyle.current = { selected: (row) => highlighted.has(row), ...rowNumbers };
  const renderers = useMemo(() => gridRenderers(() => rowNumberStyle.current), []);
  // What Glide's DataEditor adds to its core, which takes no other renderers.
  const imageWindowLoader = useMemo(() => new ImageWindowLoaderImpl(), []);
  const placeholderOnAccent = useMemo<Partial<Theme>>(
    () => ({ baseFontStyle: mutedOverride.baseFontStyle }),
    [mutedOverride],
  );
  const model = editing?.model;
  const getCellContent = useCallback(
    ([displayCol, row]: Item): GridCell => {
      const col = dataCol(displayCol);
      // A placeholder is dim on a plain row; on a selected (accent) row it keeps the row's text colour.
      const placeholderTheme = highlighted.has(row) ? placeholderOnAccent : mutedOverride;
      if (model) {
        const cell = model.cell(row, col);
        const c: CellContent = cellContent(cell.value);
        const rowInserted = model.rows[row]?.kind === "insert";
        // On a selected row the row's text is white: an edited cell keeps --modified with
        // the text that reads on it (white on light --modified would be 1.3:1).
        const editedTheme =
          cell.edited && !rowInserted
            ? highlighted.has(row)
              ? editThemes.editedOnAccent
              : editThemes.edited
            : undefined;
        const theme: Partial<Theme> | undefined =
          c.placeholder || editedTheme
            ? { ...(c.placeholder ? placeholderTheme : {}), ...editedTheme }
            : undefined;
        return {
          kind: GridCellKind.Text,
          data: c.copyText,
          displayData: c.display,
          copyData: c.copyText,
          allowOverlay: cell.editable,
          readonly: !cell.editable,
          // A link keeps its value on the left: the indicator is drawn on the right.
          contentAlign:
            c.kind === "number" && !editingRef.current?.linkAt(row, col) ? "right" : undefined,
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
        themeOverride: c.placeholder ? placeholderTheme : undefined,
      };
    },
    [model, data.rows, mutedOverride, placeholderOnAccent, editThemes, highlighted, dataCol],
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      const zebra = row % 2 === 1 ? rowThemes.odd : undefined;
      const r = model?.rows[row];
      const change =
        r?.kind === "insert" ? editThemes.inserted : r?.kind === "row" && r.deleted ? editThemes.deleted : undefined;
      const failed = r && model?.rowError(row) !== null ? editThemes.failed : undefined;
      const selected = highlighted.has(row) ? rowThemes.selected : undefined;
      if (!change && !failed && !selected) return zebra;
      return { ...zebra, ...change, ...failed, ...selected };
    },
    [model, editThemes, rowThemes, highlighted],
  );

  // Rows to delete are struck through; foreign key links get an indicator on the right.
  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      const { ctx, rect, theme: t } = args;
      const col = dataCol(args.col);
      if (editingRef.current?.linkAt(args.row, col)) {
        ctx.save();
        ctx.fillStyle = t.linkColor;
        ctx.font = `${t.baseFontStyle} ${t.fontFamily}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(strings.grid.fkIndicator, rect.x + rect.width - 4, rect.y + rect.height / 2);
        ctx.restore();
      }
      const r = model?.rows[args.row];
      if (r?.kind !== "row" || !r.deleted) return;
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
    [model, dataCol],
  );

  // Stable (Glide re-creates the editor when this changes); reads the latest props by ref.
  const provideEditor = useCallback<ProvideEditorCallback<GridCell>>(
    (cell) => {
      const ed = editingRef.current;
      if (!ed || cell.kind !== GridCellKind.Text) return undefined;
      // The cell Glide opens its editor on: the current cell (typing opens it without an
      // activation, so the cell last activated may be another one), else the activated one.
      const at = selectionRef.current.current?.cell ?? activated.current;
      const col = at ? dataCol(at[0]) : 0;
      const Editor: ProvideEditorComponent<GridCell> = (p) => {
        const value = p.value as TextCell;
        const finish = useRef(p.onFinishedEditing);
        finish.current = p.onFinishedEditing;
        // A typed character replaces the value: nothing to load then.
        const load =
          p.initialValue === undefined && at && ed.model.cell(at[1], col).truncated
            ? () => ed.loadFull(at[1], col)
            : undefined;
        return (
          <CellEditorOverlay
            value={value.data}
            load={load}
            onChange={(text) => p.onChange({ ...value, data: text })}
            onMount={() => {
              const target = at ? { id: ed.rowIdAt(at[1]), col } : null;
              editorTarget.current = target;
              closeEditor.current = () => finish.current(undefined);
              editingRef.current?.onEditorOpen(true);
              return () => {
                closeEditor.current = null;
                editingRef.current?.onEditorOpen(false);
                // After Glide reported the edit (if any) for this editor.
                setTimeout(() => {
                  if (editorTarget.current === target) editorTarget.current = null;
                }, 0);
              };
            }}
          />
        );
      };
      return { editor: Editor, disablePadding: true };
    },
    [dataCol],
  );

  const select = (s: GridSelection) => {
    // Read at once by the editor and the keys (before the re-render).
    selectionRef.current = s;
    setSelection(s);
    editingRef.current?.onSelect(selectedRowOf(s));
  };

  /** The selected cells, as the table's columns in display order (null: nothing selected). */
  const currentBlock = (): CellBlock | null => {
    const rowCount = model ? model.rows.length : data.rows.length;
    const b = selectionBlock(selectionRef.current, rowCount, shownRef.current.length);
    return b && { ...b, cols: b.cols.map(dataCol) };
  };
  /** The rows the row actions act on: selected rows, or the rows of the selected range. */
  const selectedRows = () => [...highlightedRows(selectionRef.current)].sort((a, b) => a - b);

  const copyCells = (block: CellBlock) => {
    const cols = block.cols.map((c) => names[c]);
    const rows = block.rows.map((r) => block.cols.map((c): CellValue => data.rows[r]?.[c] ?? { t: "null" }));
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(toTsv(cols, rows, { header: false })))
      .catch(() => {});
  };

  // The keys of an action, auto-repeats included (a held key is swallowed, not repeated).
  const isAction = (id: KeymapActionId, e: GridKeyEventArgs) =>
    e.rawEvent !== undefined &&
    effectiveShortcuts(id, keymapRef.current).some((s) =>
      matchCombination(e.rawEvent as unknown as KeyboardEvent, s),
    );

  // Grid keys (only while the grid has the focus and no cell editor is open: Glide's keydown).
  const onKeyDown = (e: GridKeyEventArgs) => {
    const code = e.rawEvent?.code;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    /** A held key acts once: its repeats are taken from Glide and the page, and do nothing. */
    const repeat = e.rawEvent?.repeat === true;
    const take = () => {
      e.cancel();
      e.preventDefault();
      e.stopPropagation();
      return !repeat;
    };
    // Glide starts a cell edit with any printable key typed without Ctrl / Cmd, Alt+F's "f"
    // or Ctrl+Alt+F taken for AltGr included (#102): only a character meant as text does.
    // The key still reaches the window's shortcuts.
    const raw = e.rawEvent as unknown as KeyboardEvent | undefined;
    if (raw && !e.ctrlKey && !e.metaKey && e.key.length === 1 && !typesCharacter(raw)) e.cancel();
    if (plain && code === "Enter") {
      const cur = selectionRef.current.current?.cell;
      const row = cur?.[1] ?? selectedRows()[0];
      if (row === undefined || !take()) return;
      const col = dataCol(cur?.[0] ?? 0);
      if (onQuickLook) onQuickLook(row, col);
      else setQuickLook({ row, col });
      return;
    }
    const menuKey = code === "ContextMenu" || (code === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey);
    if (menuKey && editingRef.current) {
      // The cell menu from the keyboard, under the active cell (or the grid's corner for rows).
      const cur = selectionRef.current.current?.cell;
      const row = cur?.[1] ?? selectedRows()[0];
      if (row === undefined || !take()) return;
      const area =
        e.bounds ?? (document.activeElement instanceof HTMLElement ? document.activeElement.getBoundingClientRect() : null);
      editingRef.current.onContextMenu(
        row,
        cur ? dataCol(cur[0]) : null,
        area ? area.x : 0,
        area ? area.y + (e.bounds ? e.bounds.height : HEADER_HEIGHT) : 0,
        currentBlock(),
      );
      return;
    }
    if (plain && code === "Space") {
      if (!onToggleDetails || !take()) return;
      onToggleDetails();
      return;
    }
    const remove = (plain && code === "Delete") || isAction("grid.deleteRows", e);
    if (onRowsAction && (remove || isAction("grid.duplicateRows", e))) {
      const rows = selectedRows();
      if (rows.length === 0 || !take()) return;
      onRowsAction(remove ? "delete" : "duplicate", rows);
      return;
    }
    // Page keys (Glide jumps to the first / last column on them): only here, so a text
    // field keeps its word moves.
    const page = isAction("grid.previousPage", e) ? "previous" : isAction("grid.nextPage", e) ? "next" : null;
    if (onPageKey && page) {
      if (take()) onPageKey(page);
      return;
    }
    if (isAction("grid.copyCells", e)) {
      const block = currentBlock();
      if (!block || !take()) return;
      if (onCopyCells) onCopyCells(block);
      else copyCells(block);
    }
  };

  const keybindings = useMemo(
    () => ({
      // Space shows the row details, Ctrl+Space too (window): never select a column.
      selectColumn: false,
      // Enter is Quick Look; Glide opens its cell editor on grid.setValue (Alt+Enter).
      activateCell: effectiveShortcuts("grid.setValue", keymap).map(glideHotkey).filter(Boolean).join("|"),
    }),
    [keymap],
  );

  const onHeaderContextMenu = (col: number, e: HeaderClickedEventArgs) => {
    e.preventDefault();
    setHeaderMenu({ col: dataCol(col), x: e.bounds.x + e.localEventX, y: e.bounds.y + e.localEventY });
  };

  const headerItems = (col: number): MenuItem[] => {
    const name = names[col];
    const key = keys[col];
    const out: MenuItem[] = [];
    const item = (label: string, onSelect: () => void, disabled = false) => ({ label, onSelect, disabled });
    if (onFilterColumn) out.push(item(strings.grid.headerMenu.filter, () => onFilterColumn(name)));
    out.push(
      item(
        strings.grid.headerMenu.hide,
        () => updateLayout({ hidden: [...layout.hidden, key] }),
        shownCols.length <= 1,
      ),
      item(strings.grid.headerMenu.fit, () => updateLayout({ widths: { ...layout.widths, [key]: fit(col) } })),
      item(strings.grid.headerMenu.resetPositions, () => resetLayout("order")),
      item(strings.grid.headerMenu.showAll, () => updateLayout({ hidden: [] }), layout.hidden.length === 0),
    );
    if (sortable && onSortTo) {
      out.push(
        "separator",
        item(strings.grid.headerMenu.sortAsc, () => onSortTo(name, "asc")),
        item(strings.grid.headerMenu.sortDesc, () => onSortTo(name, "desc")),
        item(strings.grid.headerMenu.sortNone, () => onSortTo(name, null), sort?.[0] !== name),
      );
    }
    out.push(
      "separator",
      item(strings.grid.headerMenu.copyName, () => {
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(name))
          .catch(() => {});
      }),
    );
    return out;
  };

  const rowCount = model ? model.rows.length : data.rows.length;
  const rowHeight = Math.max(MIN_ROW_HEIGHT, Math.round(g.fontSize * 2));
  const quickValue = quickLook
    ? model
      ? model.cell(quickLook.row, quickLook.col).value
      : data.rows[quickLook.row]?.[quickLook.col]
    : undefined;

  return (
    <>
      <DataEditorCore
        ref={gridRef}
        renderers={renderers}
        headerIcons={sprites}
        imageWindowLoader={imageWindowLoader}
        width="100%"
        height="100%"
        columns={columns}
        rows={rowCount}
        getCellContent={getCellContent}
        getCellsForSelection={true}
        theme={theme}
        rowHeight={rowHeight}
        headerHeight={HEADER_HEIGHT}
        rowMarkers={{
          kind: "number",
          width: rowNumberWidth(rowCount, markerFontSize(g.fontSize)),
          theme: rowThemes.rowNumber,
        }}
        getRowThemeOverride={getRowThemeOverride}
        smoothScrollX
        smoothScrollY
        // A header click sorts; it never selects the column (spec §5.4).
        columnSelect="none"
        cellActivationBehavior="double-click"
        keybindings={keybindings}
        minColumnWidth={RESIZE_MIN}
        maxColumnWidth={RESIZE_MAX}
        gridSelection={selection}
        onGridSelectionChange={(s: GridSelection) => {
          anchor.current = selectedRowOf(s);
          select(s);
        }}
        onKeyDown={onKeyDown}
        onHeaderClicked={(col) => {
          const name = names[dataCol(col)];
          if (sortable && name !== undefined && onSort) onSort(name);
        }}
        onHeaderContextMenu={onHeaderContextMenu}
        onColumnMoved={(from, to) => updateLayout({ order: moveColumn(layout.order, layout.hidden, from, to) })}
        onColumnResizeStart={() => {
          resizing.current = true;
        }}
        onColumnResize={(_col, newSize, index) => {
          const c = dataCol(index);
          // Outside a drag, Glide fits the column (a double click on its border): fit the page.
          const w = resizing.current ? newSize : fit(c);
          updateLayout({ widths: { ...layout.widths, [keys[c]]: w } });
        }}
        onColumnResizeEnd={() => {
          resizing.current = false;
        }}
        onCellClicked={([col, row]: Item, e: CellClickedEventArgs) => {
          if (col < 0) {
            // A row number (#78): select the row; Shift extends, Ctrl (Cmd on macOS) toggles.
            const r = rowMarkerClick(selectionRef.current, row, anchor.current, {
              shift: e.shiftKey,
              toggle: isModKey(e),
            });
            anchor.current = r.anchor;
            select(r.selection);
            // Glide prevents the press's default and does not focus for a row number: the
            // grid keys (Space, Delete, Ctrl+D…) must reach it next.
            gridRef.current?.focus();
            return;
          }
          const ed = editingRef.current;
          const c = dataCol(col);
          if (!isModKey(e) || !ed?.linkAt(row, c)) return;
          e.preventDefault();
          ed.onOpenLink(row, c);
        }}
        {...(editing && {
          drawCell,
          provideEditor,
          // Delete would clear the selected cells to "": NULL/empty are explicit menu choices.
          onDelete: () => false,
          onCellActivated: ([col, row]: Item) => {
            activated.current = [col, row];
            editingRef.current?.onActivate(row, dataCol(col));
          },
          onCellEdited: ([col, row]: Item, v: GridCell) => {
            const ed = editingRef.current;
            if (!ed || v.kind !== GridCellKind.Text) return;
            // The editor's edit goes to the record it was opened on, wherever it is now.
            const target = editorTarget.current;
            editorTarget.current = null;
            if (!target) {
              ed.onEdit(row, dataCol(col), v.data);
              return;
            }
            const at = target.id === null ? null : ed.rowById(target.id);
            if (at !== null) ed.onEdit(at, target.col, v.data);
          },
          onCellContextMenu: ([col, row]: Item, e: CellClickedEventArgs) => {
            e.preventDefault();
            editingRef.current?.onContextMenu(
              row,
              col < 0 ? null : dataCol(col),
              e.bounds.x + e.localEventX,
              e.bounds.y + e.localEventY,
              currentBlock(),
            );
          },
        })}
      />
      {headerMenu && (
        <GridContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          label={strings.grid.headerMenuLabel(names[headerMenu.col] ?? "")}
          items={headerItems(headerMenu.col)}
          onClose={() => setHeaderMenu(null)}
        />
      )}
      {quickLook && quickValue !== undefined && (
        <QuickLook
          column={names[quickLook.col] ?? ""}
          value={quickValue}
          onClose={() => setQuickLook(null)}
        />
      )}
    </>
  );
}
