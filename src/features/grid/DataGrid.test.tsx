import type {
  CellClickedEventArgs,
  DataEditorCoreProps as DataEditorProps,
  GridColumn,
  GridKeyEventArgs,
  GridSelection,
  HeaderClickedEventArgs,
} from "@glideapps/glide-data-grid";
import { CompactSelection, InnerGridCellKind, type MarkerCell, markerCellRenderer } from "@glideapps/glide-data-grid";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import type { ResultSet } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { tableInfo } from "../../test/tableInfo";
import { COL_MAX, COL_MIN } from "./columnLayout";
import { DataGrid, type DataGridProps, type GridEditing } from "./DataGrid";
import { buildGridModel } from "./editModel";
import { drawCenteredHeader } from "./headerLabels";

// The canvas grid does not run in jsdom: capture the props DataGrid gives it.
let editor: DataEditorProps | null = null;
vi.mock("@glideapps/glide-data-grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@glideapps/glide-data-grid")>()),
  DataEditorCore: (p: DataEditorProps) => {
    editor = p;
    return null;
  },
}));

const data: ResultSet = {
  columns: ["order_id", "line", "note"].map((name) => ({ name, typeName: "x" })),
  rows: [0, 1, 2].map((l) => [
    { t: "int", v: 42 },
    { t: "int", v: l },
    { t: "text", v: `n${l}` },
  ]),
  truncated: false,
};

const editing = (): GridEditing => ({
  model: buildGridModel(data, tableInfo(), undefined, false),
  onEdit: vi.fn(),
  loadFull: vi.fn(),
  onContextMenu: vi.fn(),
  linkAt: (row, col) => col === 0 && row < 3,
  onOpenLink: vi.fn(),
  onActivate: vi.fn(),
  onEditorOpen: vi.fn(),
  onSelect: vi.fn(),
  selectedRow: null,
  rowSignature: "s",
  rowIdAt: (row) => `r${row}`,
  rowById: (id) => Number(id.slice(1)),
});

const click = (over: Partial<CellClickedEventArgs> = {}) =>
  ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    bounds: { x: 100, y: 50, width: 160, height: 24 },
    localEventX: 3,
    localEventY: 4,
    ...over,
  }) as unknown as CellClickedEventArgs;

const TOKENS: Record<string, string> = {
  "--row-a": "#101010",
  "--row-b": "#202020",
  "--accent": "#3a7bf6",
  "--row-selected-text": "#ffffff",
  "--cell-focus": "#ff4245",
  "--row-selected": "#0062cc",
  "--grid-head": "#242424",
  "--head-text": "#e9e9e9",
  "--placeholder": "#737373",
  "--modified": "#ffe18e",
  "--cell-text": "#262626",
};
beforeAll(() => {
  for (const [k, v] of Object.entries(TOKENS)) document.documentElement.style.setProperty(k, v);
});
afterAll(() => {
  for (const k of Object.keys(TOKENS)) document.documentElement.style.removeProperty(k);
});

beforeEach(() => {
  editor = null;
  useGridViews.setState({ views: {}, trails: {}, layouts: {} });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});

/** The ids of the columns the grid shows, in order. */
const shown = () => editor!.columns.map((c) => c.id);
const widthOf = (id: string) => (editor!.columns.find((c) => c.id === id) as GridColumn & { width: number }).width;
const rowsOf = () => editor!.gridSelection!.rows.toArray();

const header = (over: Partial<HeaderClickedEventArgs> = {}) =>
  ({
    bounds: { x: 100, y: 0, width: 160, height: 30 },
    localEventX: 5,
    localEventY: 6,
    preventDefault: vi.fn(),
    ...over,
  }) as unknown as HeaderClickedEventArgs;

/** A key pressed in the grid (Glide's event); `cancel` stops Glide's own handling. */
const press = (
  key: string,
  code: string,
  { altGraph = false, ...mods }: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat" | "altGraph", boolean>> = {},
) => {
  const ev = { key, code, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
  const args = {
    ...ev,
    keyCode: 0,
    bounds: undefined,
    location: undefined,
    cancel: vi.fn(),
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    rawEvent: {
      ...ev,
      getModifierState: (k: string) => k === "AltGraph" && altGraph,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    },
  } as unknown as GridKeyEventArgs;
  act(() => editor!.onKeyDown!(args));
  return args;
};

test("Mod+click on a linked cell opens it; a plain click or an unlinked cell does not", () => {
  const ed = editing();
  render(<DataGrid data={data} editing={ed} />);
  act(() => editor!.onCellClicked!([0, 1], click()));
  act(() => editor!.onCellClicked!([2, 1], click({ ctrlKey: true })));
  expect(ed.onOpenLink).not.toHaveBeenCalled();
  act(() => editor!.onCellClicked!([0, 1], click({ ctrlKey: true })));
  expect(ed.onOpenLink).toHaveBeenCalledWith(1, 0);
});

test("a linked number is left-aligned (the indicator sits on the right)", () => {
  render(<DataGrid data={data} editing={editing()} />);
  expect(editor!.getCellContent([0, 0])).toMatchObject({ contentAlign: undefined });
  expect(editor!.getCellContent([1, 0])).toMatchObject({ contentAlign: "right" });
});

/** The table tab's part: the selected row follows what the grid reports. */
function Selecting({ ed, ...props }: { ed: GridEditing } & Partial<DataGridProps>) {
  const [row, setRow] = useState<number | null>(null);
  return <DataGrid data={data} {...props} editing={{ ...ed, selectedRow: row, onSelect: setRow }} />;
}

test("the context menu gets the grid's selection as a block", () => {
  const ed = editing();
  render(<Selecting ed={ed} />);
  const range: GridSelection = {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
    current: { cell: [1, 0], range: { x: 1, y: 0, width: 2, height: 2 }, rangeStack: [] },
  };
  act(() => editor!.onGridSelectionChange!(range));
  act(() => editor!.onCellContextMenu!([2, 1], click()));
  expect(ed.onContextMenu).toHaveBeenCalledWith(1, 2, 103, 54, { rows: [0, 1], cols: [1, 2] });
  // On the row marker (col -1): `col` null.
  act(() => editor!.onCellContextMenu!([-1, 2], click()));
  expect(ed.onContextMenu).toHaveBeenLastCalledWith(2, null, 103, 54, { rows: [0, 1], cols: [1, 2] });
});

/** Opens Glide's editor on `cell` (activation, then the overlay mounts). */
function openEditor(cell: [number, number], onFinishedEditing = vi.fn()) {
  act(() => editor!.onCellActivated!(cell));
  const provided = editor!.provideEditor!(editor!.getCellContent(cell)) as {
    editor: (p: Record<string, unknown>) => ReactNode;
  };
  const Editor = provided.editor;
  const value = editor!.getCellContent(cell);
  const view = render(
    <Editor value={value} onChange={vi.fn()} onFinishedEditing={onFinishedEditing} isHighlighted={false} />,
  );
  return { onFinishedEditing, view };
}

test("the cell editor's edit goes to its record, wherever that row is now", () => {
  const ed = editing();
  const ids = ["r0", "r1", "r2"];
  const moved = { ...ed, rowIdAt: (row: number) => ids[row] ?? null, rowById: vi.fn(() => 2) };
  render(<DataGrid data={data} editing={moved} />);
  openEditor([2, 1]);
  // Glide reports the index the editor opened on; the record is now at row 2.
  act(() => editor!.onCellEdited!([2, 1], { ...editor!.getCellContent([2, 1]), data: "typed" } as never));
  expect(moved.rowById).toHaveBeenCalledWith("r1");
  expect(ed.onEdit).toHaveBeenCalledWith(2, 2, "typed");
});

test("the cell editor closes, its edit dropped, when the rows change", () => {
  const ed = editing();
  const view = render(<DataGrid data={data} editing={ed} />);
  const { onFinishedEditing } = openEditor([2, 1]);
  view.rerender(<DataGrid data={data} editing={{ ...ed }} />);
  expect(onFinishedEditing).not.toHaveBeenCalled();
  view.rerender(<DataGrid data={data} editing={{ ...ed, rowSignature: "rows added" }} />);
  expect(onFinishedEditing).toHaveBeenCalledWith(undefined);
});

test("row_number_click_selects_row: click, Shift+click and Ctrl+click on the row numbers (#78)", () => {
  const ed = editing();
  const onSelect = vi.fn();
  function Track() {
    const [row, setRow] = useState<number | null>(null);
    return (
      <DataGrid
        data={data}
        editing={{ ...ed, selectedRow: row, onSelect: (r) => (onSelect(r), setRow(r)) }}
      />
    );
  }
  render(<Track />);
  expect(editor!.rowMarkers).toMatchObject({ kind: "number", width: 46 });
  act(() => editor!.onCellClicked!([-1, 0], click()));
  expect(rowsOf()).toEqual([0]);
  expect(onSelect).toHaveBeenLastCalledWith(0);
  act(() => editor!.onCellClicked!([-1, 2], click({ shiftKey: true })));
  expect(rowsOf()).toEqual([0, 1, 2]);
  act(() => editor!.onCellClicked!([-1, 1], click({ ctrlKey: true })));
  expect(rowsOf()).toEqual([0, 2]);
  // Selected rows are drawn on --row-selected (the deeper accent), in white.
  expect(editor!.getRowThemeOverride!(2)).toMatchObject({ bgCell: "#0062cc", textDark: "#ffffff" });
  expect(editor!.getRowThemeOverride!(1)?.bgCell).not.toBe("#0062cc");
});

test("row numbers select rows in query results too", () => {
  render(<DataGrid data={data} sortable={false} />);
  act(() => editor!.onCellClicked!([-1, 1], click()));
  expect(rowsOf()).toEqual([1]);
});

test("header_click_sorts_without_selecting_column", () => {
  const onSort = vi.fn();
  render(<DataGrid data={data} onSort={onSort} />);
  expect(editor!.columnSelect).toBe("none");
  act(() => editor!.onHeaderClicked!(1, header()));
  expect(onSort).toHaveBeenCalledWith("line");
  expect(editor!.gridSelection!.columns.length).toBe(0);
  // Query results do not sort.
  onSort.mockClear();
  render(<DataGrid data={data} onSort={onSort} sortable={false} />);
  act(() => editor!.onHeaderClicked!(1, header()));
  expect(onSort).not.toHaveBeenCalled();
});

test("zebra_rows: every other row uses --row-b; NULL is a dim placeholder", () => {
  const withNull: ResultSet = { ...data, rows: [[{ t: "int", v: 1 }, { t: "null" }, { t: "text", v: "" }], ...data.rows] };
  render(<DataGrid data={withNull} sortable={false} />);
  expect(editor!.getRowThemeOverride!(0)?.bgCell).toBeUndefined();
  expect(editor!.getRowThemeOverride!(1)).toMatchObject({ bgCell: "#202020" });
  expect(editor!.getRowThemeOverride!(3)).toMatchObject({ bgCell: "#202020" });
  expect(editor!.getCellContent([1, 0])).toMatchObject({
    displayData: "NULL",
    themeOverride: { textDark: "#737373", baseFontStyle: "11.5px" },
  });
  expect(editor!.getCellContent([2, 0])).toMatchObject({ displayData: "EMPTY" });
  expect(editor!.getCellContent([0, 0]).themeOverride).toBeUndefined();
});

const wide: ResultSet = {
  columns: ["id", "note", "blob"].map((name) => ({ name, typeName: "x" })),
  rows: [
    [{ t: "int", v: 1 }, { t: "text", v: "a note of medium length" }, { t: "text", v: "z".repeat(300) }],
    [{ t: "int", v: 2 }, { t: "text", v: "b" }, { t: "text", v: "short" }],
  ],
  truncated: false,
};

test("columns_autosize_within_bounds: initial widths follow the page content, 60–400 px", () => {
  render(<DataGrid data={wide} sortable={false} />);
  expect(widthOf("id")).toBe(COL_MIN);
  expect(widthOf("note")).toBeGreaterThan(COL_MIN);
  expect(widthOf("note")).toBeLessThan(COL_MAX);
  expect(widthOf("blob")).toBe(COL_MAX);
});

test("double_click_border_fits: a double click on a header border fits the column; a drag sets its width", () => {
  render(<DataGrid data={wide} sortable={false} layoutKey="k" />);
  const fitted = widthOf("note");
  const col = editor!.columns[1];
  act(() => editor!.onColumnResizeStart!(col, 100, 1, 100));
  act(() => editor!.onColumnResize!(col, 250, 1, 250));
  // Glide reports the minimum width at the end of a press without a move: ignored.
  act(() => editor!.onColumnResizeEnd!(col, 50, 1, 50));
  expect(widthOf("note")).toBe(250);
  expect(useGridViews.getState().layouts.k?.widths.note).toBe(250);
  // Glide's own fit on a border double click comes outside a drag: the grid fits the page.
  act(() => editor!.onColumnResize!(editor!.columns[1], 77, 1, 77));
  expect(widthOf("note")).toBe(fitted);
});

test("drag_reorders_and_persists: a dragged header moves its column, for this table only", () => {
  const ed = editing();
  const view = render(<DataGrid data={data} editing={ed} layoutKey="c1|public|order_lines" />);
  act(() => editor!.onColumnMoved!(0, 2));
  expect(shown()).toEqual(["line", "note", "order_id"]);
  // Cells, edits and menus follow the table's column, not the display index.
  expect(editor!.getCellContent([0, 1])).toMatchObject({ displayData: "1" });
  expect(editor!.getCellContent([2, 1])).toMatchObject({ displayData: "42" });
  act(() => editor!.onCellContextMenu!([2, 1], click()));
  expect(ed.onContextMenu).toHaveBeenLastCalledWith(1, 0, 103, 54, null);
  view.unmount();
  render(<DataGrid data={data} editing={ed} layoutKey="c1|public|order_lines" />);
  expect(shown()).toEqual(["line", "note", "order_id"]);
  render(<DataGrid data={data} editing={ed} layoutKey="c1|public|other" />);
  expect(shown()).toEqual(["order_id", "line", "note"]);
});

test("header_menu_items: filter, hide, fit, reset, show all, sort and copy the column name", async () => {
  const onSortTo = vi.fn();
  const onFilterColumn = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(
    <DataGrid data={data} onSort={vi.fn()} onSortTo={onSortTo} onFilterColumn={onFilterColumn} layoutKey="k" />,
  );
  const open = () => act(() => editor!.onHeaderContextMenu!(1, header()));
  open();
  const menu = screen.getByRole("menu", { name: strings.grid.headerMenuLabel("line") });
  expect(menu).toBeInTheDocument();
  const names = screen.getAllByRole("menuitem").map((i) => i.getAttribute("aria-label") ?? i.textContent);
  expect(names).toEqual([
    strings.grid.headerMenu.filter,
    strings.grid.headerMenu.hide,
    strings.grid.headerMenu.fit,
    strings.grid.headerMenu.resetPositions,
    strings.grid.headerMenu.showAll,
    strings.grid.headerMenu.sortAsc,
    strings.grid.headerMenu.sortDesc,
    strings.grid.headerMenu.sortNone,
    strings.grid.headerMenu.copyName,
  ]);
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.headerMenu.filter }));
  expect(onFilterColumn).toHaveBeenCalledWith("line");
  open();
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.headerMenu.sortDesc }));
  expect(onSortTo).toHaveBeenCalledWith("line", "desc");
  open();
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.headerMenu.copyName }));
  expect(writeText).toHaveBeenCalledWith("line");
  open();
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.headerMenu.hide }));
  expect(shown()).toEqual(["order_id", "note"]);
  act(() => editor!.onColumnMoved!(1, 0));
  expect(shown()).toEqual(["note", "order_id"]);
  act(() => editor!.onHeaderContextMenu!(0, header()));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.headerMenu.showAll }));
  expect(shown()).toEqual(["note", "order_id", "line"]);
  act(() => editor!.onHeaderContextMenu!(0, header()));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.headerMenu.resetPositions }));
  expect(shown()).toEqual(["order_id", "line", "note"]);
});

test("enter_quick_look_alt_enter_set_value: Enter shows the whole value, Alt+Enter edits the cell", async () => {
  const json: ResultSet = {
    columns: [{ name: "doc", typeName: "json" }],
    rows: [[{ t: "json", v: '{"a":1,"b":[1,2]}' }]],
    truncated: false,
  };
  render(<DataGrid data={json} sortable={false} />);
  // Glide opens its cell editor on Alt+Enter (and a double click), not on Enter or Space.
  expect(editor!.keybindings).toMatchObject({ activateCell: "alt+_13", selectColumn: false });
  expect(editor!.cellActivationBehavior).toBe("double-click");
  const cell: GridSelection = {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
    current: { cell: [0, 0], range: { x: 0, y: 0, width: 1, height: 1 }, rangeStack: [] },
  };
  act(() => editor!.onGridSelectionChange!(cell));
  const enter = press("Enter", "Enter");
  expect(enter.cancel).toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: strings.grid.quickLook.title("doc") });
  expect(dialog).toHaveTextContent('"a": 1');
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  // Alt+Enter is left to Glide (its activateCell binding).
  expect(press("Enter", "Enter", { altKey: true }).cancel).not.toHaveBeenCalled();
});

test("Enter in a table tab asks the tab for its Quick Look (with the table's column)", () => {
  const onQuickLook = vi.fn();
  render(<Selecting ed={editing()} onQuickLook={onQuickLook} layoutKey="q" />);
  act(() => editor!.onColumnMoved!(2, 0));
  act(() =>
    editor!.onGridSelectionChange!({
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: { cell: [0, 1], range: { x: 0, y: 1, width: 1, height: 1 }, rangeStack: [] },
    }),
  );
  press("Enter", "Enter");
  expect(onQuickLook).toHaveBeenCalledWith(1, 2);
});

test("space_toggles_row_detail: Space in the grid toggles the row details; Ctrl+Space is left to the tab", () => {
  const onToggleDetails = vi.fn();
  render(<DataGrid data={data} editing={editing()} onToggleDetails={onToggleDetails} />);
  const space = press(" ", "Space");
  expect(space.cancel).toHaveBeenCalled();
  expect(onToggleDetails).toHaveBeenCalledOnce();
  // Ctrl+Space bubbles to the window, where grid.rowDetails is bound (no double toggle).
  const ctrl = press(" ", "Space", { ctrlKey: true });
  expect(ctrl.cancel).not.toHaveBeenCalled();
  expect(onToggleDetails).toHaveBeenCalledOnce();
});

test("grid keys act on the selected rows: Delete / Ctrl+Backspace delete, Ctrl+D duplicates, Ctrl+Shift+C copies", () => {
  const onRowsAction = vi.fn();
  const onCopyCells = vi.fn();
  render(<Selecting ed={editing()} onRowsAction={onRowsAction} onCopyCells={onCopyCells} />);
  act(() => editor!.onCellClicked!([-1, 0], click()));
  act(() => editor!.onCellClicked!([-1, 2], click({ shiftKey: true })));
  expect(press("Delete", "Delete").cancel).toHaveBeenCalled();
  expect(onRowsAction).toHaveBeenLastCalledWith("delete", [0, 1, 2]);
  press("Backspace", "Backspace", { ctrlKey: true });
  expect(onRowsAction).toHaveBeenCalledTimes(2);
  press("d", "KeyD", { ctrlKey: true });
  expect(onRowsAction).toHaveBeenLastCalledWith("duplicate", [0, 1, 2]);
  press("C", "KeyC", { ctrlKey: true, shiftKey: true });
  expect(onCopyCells).toHaveBeenCalledWith({ rows: [0, 1, 2], cols: [0, 1, 2], wholeRows: true });
  // A plain Backspace or letter is not a grid action.
  expect(press("Backspace", "Backspace").cancel).not.toHaveBeenCalled();
  expect(onRowsAction).toHaveBeenCalledTimes(3);
});

test("only a character meant as text starts a cell edit: never Alt+letter or Ctrl+Alt+letter taken for AltGr (#102)", () => {
  render(<Selecting ed={editing()} />);
  // Plain and Shift letters type (Glide opens the editor with them).
  expect(press("f", "KeyF").cancel).not.toHaveBeenCalled();
  expect(press("F", "KeyF", { shiftKey: true }).cancel).not.toHaveBeenCalled();
  // Alt+F (Columns) and Alt+& (AZERTY Alt+1) are shortcuts, not text.
  expect(press("f", "KeyF", { altKey: true }).cancel).toHaveBeenCalled();
  expect(press("&", "Digit1", { altKey: true }).cancel).toHaveBeenCalled();
  // Ctrl+Alt+F reported as an AltGr chord (WebKitGTK) is no text either.
  expect(press("f", "KeyF", { altGraph: true }).cancel).toHaveBeenCalled();
  expect(press("f", "KeyF", { altGraph: true, altKey: true }).cancel).toHaveBeenCalled();
  // AltGr symbols are text: AltGr+E "€", AltGr+0 "@" (AZERTY), with or without Alt down.
  expect(press("€", "KeyE", { altGraph: true }).cancel).not.toHaveBeenCalled();
  expect(press("@", "Digit0", { altGraph: true, altKey: true }).cancel).not.toHaveBeenCalled();
  // Ctrl / Cmd combinations are left to Glide (it never types them: Ctrl+A selects all).
  expect(press("a", "KeyA", { ctrlKey: true }).cancel).not.toHaveBeenCalled();
});

test("row numbers: our marker renderer, right-aligned, header colours; a selected row's number on --row-selected (#103)", () => {
  render(<Selecting ed={editing()} />);
  expect(editor!.rowMarkers).toMatchObject({ kind: "number", width: 46 });
  const renderer = editor!.renderers!.find((r) => r.kind === InnerGridCellKind.Marker)!;
  expect(renderer).not.toBe(markerCellRenderer);
  const drawRow = (row: number) => {
    const fills: string[] = [];
    const ctx = {
      fillStyle: "",
      font: "",
      textAlign: "start",
      save: vi.fn(),
      restore: vi.fn(),
      measureText: () => ({ actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 0 }),
      fillRect: () => fills.push(`rect ${ctx.fillStyle}`),
      fillText: () => fills.push(`text ${ctx.fillStyle} ${ctx.textAlign}`),
    };
    const cell = { kind: InnerGridCellKind.Marker, row: row + 1, markerKind: "number" } as unknown as MarkerCell;
    renderer.draw(
      {
        ctx,
        rect: { x: 0, y: 0, width: 46, height: 26 },
        theme: { textLight: "#737373", markerFontStyle: "11px", bgCell: "#2a2a2a" },
        row,
        col: 0,
        cell,
      } as unknown as Parameters<typeof renderer.draw>[0],
      cell,
    );
    return fills;
  };
  // Every row, zebra or not: the header's background and text.
  expect(drawRow(1)).toEqual(["rect #242424", "text #e9e9e9 right"]);
  act(() => editor!.onCellClicked!([-1, 1], click()));
  expect(drawRow(1)).toEqual(["rect #0062cc", "text #ffffff right"]);
  expect(drawRow(0)).toEqual(["rect #242424", "text #e9e9e9 right"]);
  // Selected rows are filled with --row-selected (not the accent: white reads 4.0:1 there).
  expect(editor!.getRowThemeOverride!(1)).toMatchObject({ bgCell: "#0062cc", accentLight: "#0062cc", textDark: "#ffffff" });
});

test("selection_count: the grid reports how many rows are selected (row numbers or the active cell's rows)", () => {
  const onSelectedRows = vi.fn();
  render(<Selecting ed={editing()} onSelectedRows={onSelectedRows} />);
  expect(onSelectedRows).toHaveBeenLastCalledWith(0);
  act(() => editor!.onCellClicked!([-1, 1], click()));
  expect(onSelectedRows).toHaveBeenLastCalledWith(1);
  act(() => editor!.onCellClicked!([-1, 2], click({ shiftKey: true })));
  expect(onSelectedRows).toHaveBeenLastCalledWith(2);
  act(() =>
    editor!.onGridSelectionChange!({
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: { cell: [2, 0], range: { x: 2, y: 0, width: 1, height: 1 }, rangeStack: [] },
    }),
  );
  expect(onSelectedRows).toHaveBeenLastCalledWith(1);
});

test("centred_headers: the grid draws its column labels centred (drawHeader)", () => {
  render(<DataGrid data={data} editing={editing()} />);
  expect(editor!.drawHeader).toBe(drawCenteredHeader);
});

test("the ContextMenu key and Shift+F10 open the cell menu of the active cell", () => {
  const ed = editing();
  render(<Selecting ed={ed} />);
  act(() =>
    editor!.onGridSelectionChange!({
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: { cell: [2, 1], range: { x: 2, y: 1, width: 1, height: 1 }, rangeStack: [] },
    }),
  );
  expect(press("ContextMenu", "ContextMenu").cancel).toHaveBeenCalled();
  expect(ed.onContextMenu).toHaveBeenLastCalledWith(1, 2, 0, 30, { rows: [1], cols: [2] });
  press("F10", "F10", { shiftKey: true });
  expect(ed.onContextMenu).toHaveBeenCalledTimes(2);
});

test("an edited cell on a selected row keeps its edit colour with readable text (fix 1)", () => {
  const ed = editing();
  const model = ed.model;
  const edited = { ...model, cell: (r: number, c: number) => ({ ...model.cell(r, c), edited: c === 2 }) };
  render(<Selecting ed={{ ...ed, model: edited }} />);
  // Not selected: the edit colour alone.
  expect(editor!.getCellContent([2, 1]).themeOverride).toEqual({ bgCell: "#ffe18e" });
  act(() => editor!.onCellClicked!([-1, 1], click()));
  // Selected (white text on the accent row): the edit keeps --modified, with the text that
  // reads best on it (here --cell-text: white on #ffe18e is 1.3:1).
  expect(editor!.getCellContent([2, 1]).themeOverride).toMatchObject({
    bgCell: "#ffe18e",
    accentLight: "#ffe18e",
    textDark: "#262626",
  });
  expect(editor!.getCellContent([1, 1]).themeOverride).toBeUndefined();
});

test("a whole-row selection marks its block, so a hidden column does not shrink it to one row (fix 2)", () => {
  const ed = editing();
  render(<Selecting ed={ed} layoutKey="hide" />);
  act(() => useGridViews.getState().setLayout("hide", { hidden: ["note"] }));
  act(() => editor!.onCellClicked!([-1, 0], click()));
  act(() => editor!.onCellClicked!([-1, 2], click({ shiftKey: true })));
  act(() => editor!.onCellContextMenu!([-1, 1], click()));
  expect(ed.onContextMenu).toHaveBeenLastCalledWith(1, null, 103, 54, { rows: [0, 1, 2], cols: [0, 1], wholeRows: true });
});

test("type-to-edit writes to the cell being typed in, not to the cell last opened (fix 3)", () => {
  const ed = editing();
  render(<Selecting ed={ed} />);
  const at = (col: number, row: number): GridSelection => ({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
    current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
  });
  // Double click on A (col 2, row 0) and edit it.
  act(() => editor!.onGridSelectionChange!(at(2, 0)));
  const first = openEditor([2, 0]);
  act(() => editor!.onCellEdited!([2, 0], { ...editor!.getCellContent([2, 0]), data: "a" } as never));
  expect(ed.onEdit).toHaveBeenLastCalledWith(0, 2, "a");
  first.view.unmount();
  // Click B (col 1, row 2) and type: Glide opens the editor without activating the cell.
  act(() => editor!.onGridSelectionChange!(at(1, 2)));
  const provided = editor!.provideEditor!(editor!.getCellContent([1, 2])) as {
    editor: (p: Record<string, unknown>) => ReactNode;
  };
  const Editor = provided.editor;
  render(
    <Editor
      value={editor!.getCellContent([1, 2])}
      initialValue="x"
      onChange={vi.fn()}
      onFinishedEditing={vi.fn()}
      isHighlighted={false}
    />,
  );
  act(() => editor!.onCellEdited!([1, 2], { ...editor!.getCellContent([1, 2]), data: "x" } as never));
  expect(ed.onEdit).toHaveBeenLastCalledWith(2, 1, "x");
});

test("held keys act once: the repeats of Enter, Space and Delete are swallowed (fix 4)", () => {
  const onToggleDetails = vi.fn();
  const onRowsAction = vi.fn();
  const onQuickLook = vi.fn();
  render(<Selecting ed={editing()} onToggleDetails={onToggleDetails} onRowsAction={onRowsAction} onQuickLook={onQuickLook} />);
  act(() => editor!.onCellClicked!([-1, 1], click()));
  for (const [key, code] of [[" ", "Space"], ["Delete", "Delete"], ["Enter", "Enter"], ["d", "KeyD"]] as const) {
    const held = press(key, code, { repeat: true, ctrlKey: code === "KeyD" });
    expect(held.cancel, code).toHaveBeenCalled();
    expect(held.preventDefault, code).toHaveBeenCalled();
  }
  expect(onToggleDetails).not.toHaveBeenCalled();
  expect(onRowsAction).not.toHaveBeenCalled();
  expect(onQuickLook).not.toHaveBeenCalled();
});

test("Ctrl+← / Ctrl+→ in the grid ask for the previous / next page instead of Glide's column jump", () => {
  const onPageKey = vi.fn();
  render(<DataGrid data={data} editing={editing()} onPageKey={onPageKey} />);
  const left = press("ArrowLeft", "ArrowLeft", { ctrlKey: true });
  expect(left.cancel).toHaveBeenCalled();
  expect(onPageKey).toHaveBeenLastCalledWith("previous");
  press("ArrowRight", "ArrowRight", { ctrlKey: true });
  expect(onPageKey).toHaveBeenLastCalledWith("next");
  // A held key pages once.
  expect(press("ArrowRight", "ArrowRight", { ctrlKey: true, repeat: true }).cancel).toHaveBeenCalled();
  expect(onPageKey).toHaveBeenCalledTimes(2);
  // Plain and Shift arrows stay Glide's (move, extend the selection).
  expect(press("ArrowLeft", "ArrowLeft").cancel).not.toHaveBeenCalled();
  expect(press("ArrowLeft", "ArrowLeft", { ctrlKey: true, shiftKey: true }).cancel).not.toHaveBeenCalled();
  expect(onPageKey).toHaveBeenCalledTimes(2);
});
