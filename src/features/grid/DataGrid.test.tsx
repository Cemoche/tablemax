import type { CellClickedEventArgs, DataEditorProps, GridSelection } from "@glideapps/glide-data-grid";
import { CompactSelection } from "@glideapps/glide-data-grid";
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ResultSet } from "../../lib/types";
import { tableInfo } from "../../test/tableInfo";
import { DataGrid, type GridEditing } from "./DataGrid";
import { buildGridModel } from "./editModel";

// The canvas grid does not run in jsdom: capture the props DataGrid gives it.
let editor: DataEditorProps | null = null;
vi.mock("@glideapps/glide-data-grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@glideapps/glide-data-grid")>()),
  DataEditor: (p: DataEditorProps) => {
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

beforeEach(() => {
  editor = null;
});

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
function Selecting({ ed }: { ed: GridEditing }) {
  const [row, setRow] = useState<number | null>(null);
  return <DataGrid data={data} editing={{ ...ed, selectedRow: row, onSelect: setRow }} />;
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
