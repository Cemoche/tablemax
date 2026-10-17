import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { CellValue, ForeignKeyInfo, ResultSet, RowKey } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { usePendingChanges } from "../../stores/pendingChanges";
import { useWorkspaces } from "../../stores/workspaces";
import { tableInfo } from "../../test/tableInfo";
import type { DataGridProps } from "./DataGrid";
import { TableDataTab } from "./TableDataTab";

vi.mock("../../lib/ipc");
let grid: DataGridProps | null = null;
vi.mock("./DataGrid", () => ({
  DataGrid: (p: DataGridProps) => {
    grid = p;
    return <div data-testid="grid" />;
  },
}));

let structureMounts = 0;
vi.mock("../structure/StructureTab", async () => {
  const { useEffect } = await import("react");
  return {
    StructureTab: (p: { object: { name: string } }) => {
      useEffect(() => {
        structureMounts++;
      }, []);
      return <div data-testid="structure">{p.object.name}</div>;
    },
  };
});

const obj = { schema: "public", name: "order_lines" };
const page = (n: number) => ({
  columns: [{ name: "id", typeName: "int" }],
  rows: Array.from({ length: n }, (_, i) => [{ t: "int" as const, v: i }]),
  truncated: false,
});
const int = (v: number): CellValue => ({ t: "int", v });
const names = ["id", "order_id", "line", "note", "total", "data"];
const lines = (n: number): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: "x" })),
  rows: Array.from({ length: n }, (_, i) => [
    int(100 + i),
    int(42),
    int(i),
    { t: "text", v: `note ${i}` },
    { t: "decimal", v: "1.50" },
    { t: "null" },
  ]),
  truncated: false,
});
const key = (line: number): RowKey => [
  ["order_id", int(42)],
  ["line", int(line)],
];
const pending = () => usePendingChanges.getState();

beforeEach(() => {
  vi.resetAllMocks();
  grid = null;
  structureMounts = 0;
  useGridViews.setState({ views: {}, trails: {} });
  usePendingChanges.setState({ tabs: {}, blocked: {}, committing: {}, applied: {}, editorOpen: {} });
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo());
  vi.mocked(ipc.changesPreview).mockResolvedValue([]);
});

test("footer shows range with ≈ for estimates and pages forward", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(page(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 1234567 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() =>
    expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–300 of ≈ 1,234,567"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 301–600 of ≈ 1,234,567"),
  );
  expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
});

test("error shows message with Retry; connectionLost hints", async () => {
  vi.mocked(ipc.tablePage).mockRejectedValueOnce({ kind: "connectionLost", message: "server gone" });
  vi.mocked(ipc.tablePage).mockResolvedValue(page(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  expect(await screen.findByText("server gone")).toBeInTheDocument();
  expect(screen.getByText(/reopen the connection/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–1 of 1");
});

test("a read-only table shows why and offers no + Row", async () => {
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo({ rowKey: null, primaryKey: [] }));
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  expect(await screen.findByText(strings.grid.readOnlyNoKey)).toBeInTheDocument();
  expect(ipc.tableInfo).toHaveBeenCalledWith("w1", obj, false);
  expect(screen.queryByRole("button", { name: strings.grid.addRow })).toBeNull();
  expect(screen.queryByRole("button", { name: strings.grid.commit("Ctrl+S") })).toBeNull();
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).editable).toBe(false));
});

test("editing through the grid, then commit applies the changes and reloads", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  vi.mocked(ipc.changesApply).mockResolvedValue({
    applied: true,
    affected: [1, 1],
    failedIndex: null,
    error: null,
  });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  const commit = await screen.findByRole("button", { name: strings.grid.commit("Ctrl+S") });
  expect(commit).toBeDisabled();
  expect(screen.getByRole("button", { name: strings.grid.discard })).toBeDisabled();
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  expect(screen.getByText(strings.grid.pendingCount(2))).toBeInTheDocument();
  const changes = pending().toChanges("t1");
  expect(changes).toEqual([
    { kind: "update", key: key(1), set: [["note", { t: "text", v: "changed" }]] },
    { kind: "insert", values: [] },
  ]);
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.commit("Ctrl+S") }));
  expect(ipc.changesApply).toHaveBeenCalledWith("w1", obj, changes);
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  expect(ipc.tableCount).toHaveBeenCalledTimes(2);
  expect(pending().count("t1")).toBe(0);
  expect(screen.queryByText(strings.grid.pendingCount(2))).toBeNull();
});

test("a failed change shows its message and every change stays pending", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  vi.mocked(ipc.changesApply).mockResolvedValue({
    applied: false,
    affected: [1, 0],
    failedIndex: 1,
    error: { kind: "query", message: "the row was deleted or its key changed since it was loaded" },
  });
  pending().setCell("t1", obj, key(0), "note", { t: "null" }, lines(1).rows[0], names);
  pending().toggleDelete("t1", obj, key(2));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await userEvent.click(await screen.findByRole("button", { name: strings.grid.commit("Ctrl+S") }));
  expect(
    await screen.findByText(
      strings.grid.changeFailed(2, "the row was deleted or its key changed since it was loaded"),
    ),
  ).toBeInTheDocument();
  expect(pending().count("t1")).toBe(2);
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(grid?.editing?.model.rowState(2)).toBe("failed"));
});

test("paging and sorting are blocked while changes are pending", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  pending().toggleDelete("t1", obj, key(0));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–300 of 900"));
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  act(() => grid!.onSort!("note"));
  expect(useGridViews.getState().getView("t1")).toEqual({ page: 0, sort: null, filters: [] });
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.discard }));
  expect(screen.queryByText(strings.grid.commitOrDiscardFirst)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
});

test("context menu: Set NULL on a cell and Delete row", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.setNull }));
  act(() => grid!.editing!.onContextMenu(1, null, 5, 5));
  expect(screen.queryByRole("menuitem", { name: strings.grid.menu.setNull })).toBeNull();
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.deleteRow }));
  expect(pending().toChanges("t1")).toEqual([
    { kind: "update", key: key(0), set: [["note", { t: "null" }]] },
    { kind: "delete", key: key(1) },
  ]);
});

test("Duplicate row loads truncated values in full first", async () => {
  const data = lines(1);
  data.rows[0][3] = { t: "longText", v: { preview: "abc", len: 20000 } };
  vi.mocked(ipc.tablePage).mockResolvedValue(data);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  vi.mocked(ipc.cellValue).mockResolvedValue({ t: "text", v: "full text" });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.duplicateRow }));
  await waitFor(() => expect(pending().count("t1")).toBe(1));
  expect(ipc.cellValue).toHaveBeenCalledWith("w1", obj, key(0), "note");
  expect(pending().toChanges("t1")).toEqual([
    {
      kind: "insert",
      values: [
        ["order_id", { t: "text", v: "42" }],
        ["line", { t: "text", v: "0" }],
        ["note", { t: "text", v: "full text" }],
      ],
    },
  ]);
});

test("the editor loads the full value of a truncated cell", async () => {
  const data = lines(1);
  data.rows[0][3] = { t: "longText", v: { preview: "abc", len: 20000 } };
  vi.mocked(ipc.tablePage).mockResolvedValue(data);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  vi.mocked(ipc.cellValue).mockResolvedValue({ t: "text", v: "the whole text" });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).truncated).toBe(true));
  await expect(grid!.editing!.loadFull(0, 3)).resolves.toBe("the whole text");
  expect(ipc.cellValue).toHaveBeenCalledWith("w1", obj, key(0), "note");
});

test("Reload is blocked while changes are pending", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  pending().toggleDelete("t1", obj, key(0));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–2 of 2"));
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(screen.getByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
});

test("Duplicate row copies the pending edits of the row", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(0, 3, "as edited"));
  act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.duplicateRow }));
  await waitFor(() => expect(pending().count("t1")).toBe(2));
  expect(pending().toChanges("t1")[1]).toEqual({
    kind: "insert",
    values: [
      ["order_id", { t: "text", v: "42" }],
      ["line", { t: "text", v: "0" }],
      ["note", { t: "text", v: "as edited" }],
    ],
  });
});

test("the grid reports when its cell editor is open", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing).toBeDefined());
  act(() => grid!.editing!.onEditorOpen(true));
  expect(pending().editorOpen.t1).toBe(true);
  act(() => grid!.editing!.onEditorOpen(false));
  expect(pending().editorOpen.t1).toBe(false);
});

test("the pending changes panel opens with the first change", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesPreview).mockResolvedValue(["DELETE …"]);
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).editable).toBe(true));
  expect(screen.queryByRole("button", { name: strings.grid.changes.title(1) })).toBeNull();
  act(() => grid!.editing!.onContextMenu(1, null, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.deleteRow }));
  expect(screen.getByRole("button", { name: strings.grid.changes.title(1) })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await screen.findByText("DELETE …")).toBeInTheDocument();
  expect(ipc.changesPreview).toHaveBeenCalledWith("w1", obj, [{ kind: "delete", key: key(1) }]);
});

test("Row details shows the selected row, follows it and edits it through the store", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  const toggle = screen.getByRole("button", { name: strings.grid.rowDetails });
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText(strings.grid.rowDetailsEmpty)).toBeInTheDocument();
  act(() => grid!.editing!.onSelect(1));
  const note = () => screen.getByLabelText("note") as HTMLTextAreaElement;
  expect(note().value).toBe("note 1");
  // A new row shifts the display rows: the panel stays on the same row.
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  expect(note().value).toBe("note 1");
  await userEvent.type(note(), "!");
  expect(pending().toChanges("t1")[0]).toEqual({
    kind: "update",
    key: key(1),
    set: [["note", { t: "text", v: "note 1!" }]],
  });
  await userEvent.keyboard("{Control>}i{/Control}");
  expect(screen.queryByRole("complementary", { name: strings.grid.rowDetails })).toBeNull();
  await userEvent.keyboard("{Control>}i{/Control}");
  expect(screen.getByRole("complementary", { name: strings.grid.rowDetails })).toBeInTheDocument();
});

/** `lines(n)` with the given `line` values (in that order) and notes. */
const linesWith = (keys: number[], note = (l: number) => `note ${l}`): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: "x" })),
  rows: keys.map((l) => [int(100 + l), int(42), int(l), { t: "text", v: note(l) }, { t: "decimal", v: "1.50" }, { t: "null" }]),
  truncated: false,
});

test("a commit and a reload with shifted rows keep the details on the same record", async () => {
  vi.mocked(ipc.tablePage)
    .mockResolvedValueOnce(linesWith([0, 1, 2]))
    .mockResolvedValue(linesWith([7, 8, 0, 1, 2], (l) => (l === 1 ? "note 1 saved" : `note ${l}`)));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  vi.mocked(ipc.changesApply).mockResolvedValue({ applied: true, affected: [1], failedIndex: null, error: null });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.rowDetails }));
  act(() => grid!.editing!.onSelect(1));
  const note = () => screen.getByLabelText("note") as HTMLTextAreaElement;
  await userEvent.type(note(), "!");
  expect(note()).toHaveFocus();
  // Mod+S while the field still has the focus: the typed text is already pending.
  await act(() => pending().commit("t1", "w1", obj));
  expect(ipc.changesApply).toHaveBeenCalledWith("w1", obj, [
    { kind: "update", key: key(1), set: [["note", { t: "text", v: "note 1!" }]] },
  ]);
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  // line 1 is now the 4th row: the panel follows it and shows the reloaded value.
  await waitFor(() => expect(note().value).toBe("note 1 saved"));
  expect(grid!.editing!.selectedRow).toBe(3);
  await userEvent.type(note(), "?");
  expect(pending().toChanges("t1")).toEqual([
    { kind: "update", key: key(1), set: [["note", { t: "text", v: "note 1 saved?" }]] },
  ]);
});

test("a record missing from the new page leaves the details empty", async () => {
  vi.mocked(ipc.tablePage)
    .mockResolvedValueOnce(linesWith([0, 1, 2]))
    .mockResolvedValue(linesWith([300, 301]));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.rowDetails }));
  act(() => grid!.editing!.onSelect(1));
  expect((screen.getByLabelText("note") as HTMLTextAreaElement).value).toBe("note 1");
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.getByText(strings.grid.rowDetailsEmpty)).toBeInTheDocument());
  expect(grid!.editing!.selectedRow).toBeNull();
});

test("+ Row moves the grid selection with the selected record", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.rowDetails }));
  act(() => grid!.editing!.onSelect(1));
  expect(grid!.editing!.selectedRow).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  expect(grid!.editing!.selectedRow).toBe(2);
  expect((screen.getByLabelText("note") as HTMLTextAreaElement).value).toBe("note 1");
});

test("the quick filter reloads page 0 filtered and a capped count shows 500,000+", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("of 3"));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 500000 });
  await userEvent.type(
    screen.getByRole("textbox", { name: strings.filters.quickLabel }),
    "note contains x{Enter}",
  );
  const filters = [{ column: "note", op: "contains", values: ["x"] }];
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 0, filters })),
  );
  expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", obj, filters);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–3 of 500,000+"));
  expect(screen.getByRole("button", { name: strings.filters.button(1) })).toBeInTheDocument();
});

test("a filter change with pending changes is blocked like a page change", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await userEvent.click(await screen.findByRole("button", { name: strings.grid.addRow }));
  const quick = screen.getByRole("textbox", { name: strings.filters.quickLabel });
  await userEvent.type(quick, "id = 1{Enter}");
  expect(await screen.findByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  expect(quick).toHaveValue("id = 1");
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  expect(useGridViews.getState().getView("t1").filters).toEqual([]);
});

const ordersRef = { schema: "public", name: "orders" };
const fkInfo = (over: Partial<ForeignKeyInfo> = {}) =>
  tableInfo({
    foreignKeys: [
      {
        name: "order_lines_order_fk",
        columns: ["order_id"],
        refSchema: "public",
        refTable: "orders",
        refColumns: ["id"],
        onUpdate: "NO ACTION",
        onDelete: "CASCADE",
        ...over,
      },
    ],
  });

/** Tab t1 of workspace w1 showing order_lines, rendered from the store like WorkspaceView. */
function setTab() {
  useWorkspaces.setState({
    workspaces: [
      {
        id: "w1",
        connectionId: "c1",
        name: "PG",
        color: "swatch-1",
        envTag: "local",
        dialect: "postgres",
        schemas: ["public"],
        currentSchema: "public",
        tabs: [{ id: "t1", kind: "table", object: obj, title: obj.name }],
        activeTabId: "t1",
      },
    ],
    activeWorkspaceId: "w1",
  });
}
function StoreTab() {
  const tab = useWorkspaces((s) => s.workspaces[0].tabs[0]);
  if (tab.kind !== "table") return null;
  return <TableDataTab workspaceId="w1" tabId="t1" object={tab.object} dialect="postgres" />;
}
const theTab = () => useWorkspaces.getState().workspaces[0].tabs[0];

test("Ctrl+click on a foreign key opens the referenced row in the same tab", async () => {
  setTab();
  vi.mocked(ipc.tableInfo).mockResolvedValue(fkInfo());
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<StoreTab />);
  await waitFor(() => expect(grid?.editing?.linkAt(0, 1)).toBe(true));
  expect(grid!.editing!.linkAt(0, 3)).toBe(false);
  act(() => grid!.editing!.onOpenLink(0, 1));
  const filters = [{ column: "id", op: "eq", values: ["42"] }];
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", {
      object: ordersRef,
      limit: 300,
      offset: 0,
      sort: null,
      filters,
    }),
  );
  expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", ordersRef, filters);
  expect(ipc.tableInfo).toHaveBeenLastCalledWith("w1", ordersRef, false);
  expect(theTab()).toMatchObject({ id: "t1", object: ordersRef, title: "orders" });
  expect(screen.getByRole("navigation", { name: strings.grid.trail.label })).toHaveTextContent(
    "order_lines›orders (id = 42)",
  );
});

test("a composite foreign key filters on every referenced column (menu entry)", async () => {
  setTab();
  vi.mocked(ipc.tableInfo).mockResolvedValue(
    fkInfo({ columns: ["order_id", "line"], refTable: "shipments", refColumns: ["order_ref", "line_no"] }),
  );
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<StoreTab />);
  await waitFor(() => expect(grid?.editing?.linkAt(1, 2)).toBe(true));
  act(() => grid!.editing!.onContextMenu(1, 2, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.openReferenced }));
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith(
      "w1",
      expect.objectContaining({
        object: { schema: "public", name: "shipments" },
        filters: [
          { column: "order_ref", op: "eq", values: ["42"] },
          { column: "line_no", op: "eq", values: ["1"] },
        ],
      }),
    ),
  );
});

test("opening a referenced row is blocked while changes are pending", async () => {
  setTab();
  vi.mocked(ipc.tableInfo).mockResolvedValue(fkInfo());
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  pending().toggleDelete("t1", obj, key(1));
  render(<StoreTab />);
  await waitFor(() => expect(grid?.editing?.linkAt(0, 1)).toBe(true));
  act(() => grid!.editing!.onOpenLink(0, 1));
  expect(await screen.findByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  expect(theTab()).toMatchObject({ object: obj });
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  expect(useGridViews.getState().getTrail("t1")).toEqual([]);
});

test("the row details link opens the referenced row and the details stay open", async () => {
  setTab();
  vi.mocked(ipc.tableInfo).mockResolvedValue(fkInfo());
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<StoreTab />);
  await waitFor(() => expect(grid?.editing?.linkAt(0, 1)).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.rowDetails }));
  act(() => grid!.editing!.onSelect(0));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.openReferencedIn("orders") }));
  await waitFor(() => expect(theTab()).toMatchObject({ object: ordersRef }));
  expect(screen.getByRole("button", { name: strings.grid.rowDetails })).toHaveAttribute("aria-pressed", "true");
});

/** A clipboard holding the last text written (jsdom has none). */
function stubClipboard() {
  const clip = { text: "", writeText: vi.fn(async (t: string) => void (clip.text = t)) };
  Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
  return clip;
}

test("Copy as CSV / SQL INSERT copies the displayed selection, without new rows", async () => {
  const clip = stubClipboard();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  // Display rows: 0 = the new row, 1 = line 0, 2 = line 1 (with a pending edit).
  act(() => grid!.editing!.onEdit(2, 3, "it's edited"));
  const block = { rows: [0, 1, 2], cols: [2, 3] };
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.csv }));
  await waitFor(() =>
    expect(clip.text).toBe("line,note\r\n0,note 0\r\n1,it's edited"),
  );
  expect(screen.getByText(strings.grid.copySkippedInserts(1))).toBeInTheDocument();
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.insert }));
  await waitFor(() =>
    expect(clip.text).toBe(
      `INSERT INTO "public"."order_lines" ("line", "note") VALUES (0, 'note 0');\n` +
        `INSERT INTO "public"."order_lines" ("line", "note") VALUES (1, 'it''s edited');`,
    ),
  );
});

test("Copy as JSON of a clicked cell outside the selection; a clipboard error shows inline", async () => {
  const clip = stubClipboard();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(1, 4, 5, 5, { rows: [0], cols: [0] }));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.json }));
  await waitFor(() =>
    expect(clip.text).toBe('[\n  {\n    "total": "1.50"\n  }\n]'),
  );
  clip.writeText.mockRejectedValue(new Error("denied"));
  act(() => grid!.editing!.onContextMenu(1, 4, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.tsv }));
  expect(await screen.findByText(strings.grid.copyFailed("denied"))).toBeInTheDocument();
});

test("a read-only table still offers the copy entries", async () => {
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo({ rowKey: null, primaryKey: [] }));
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await screen.findByText(strings.grid.readOnlyNoKey);
  await waitFor(() => expect(grid?.editing).toBeDefined());
  act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
  expect(screen.getByRole("menuitem", { name: strings.grid.copyAs.tsv })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: strings.grid.menu.setNull })).toBeNull();
});

test("a column in two foreign keys offers one menu entry per referenced table", async () => {
  setTab();
  const base = fkInfo().foreignKeys[0];
  vi.mocked(ipc.tableInfo).mockResolvedValue(
    tableInfo({ foreignKeys: [base, { ...base, name: "archive_fk", refTable: "orders_archive" }] }),
  );
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<StoreTab />);
  await waitFor(() => expect(grid?.editing?.linkAt(0, 1)).toBe(true));
  act(() => grid!.editing!.onContextMenu(0, 1, 5, 5));
  expect(screen.queryByRole("menuitem", { name: strings.grid.menu.openReferenced })).toBeNull();
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.openReferencedIn("orders_archive") }));
  await waitFor(() => expect(theTab()).toMatchObject({ object: { schema: "public", name: "orders_archive" } }));
});

test("a Duplicate row still loading when the tab navigates adds nothing", async () => {
  setTab();
  const data = lines(1);
  data.rows[0][3] = { t: "longText", v: { preview: "abc", len: 20000 } };
  vi.mocked(ipc.tableInfo).mockResolvedValue(fkInfo());
  vi.mocked(ipc.tablePage).mockResolvedValue(data);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  let resolve: (v: CellValue) => void = () => {};
  vi.mocked(ipc.cellValue).mockReturnValue(new Promise<CellValue>((r) => (resolve = r)));
  render(<StoreTab />);
  await waitFor(() => expect(grid?.editing?.linkAt(0, 1)).toBe(true));
  act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.duplicateRow }));
  expect(ipc.cellValue).toHaveBeenCalled();
  act(() => grid!.editing!.onOpenLink(0, 1));
  await waitFor(() => expect(theTab()).toMatchObject({ object: ordersRef }));
  await act(async () => resolve({ t: "text", v: "full text" }));
  expect(pending().count("t1")).toBe(0);
});

test("a copy notice can be dismissed and clears itself after a while", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
    vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // After setup(), which installs its own clipboard.
    const clip = stubClipboard();
    clip.writeText.mockRejectedValue(new Error("denied"));
    render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
    await waitFor(() => expect(grid?.editing).toBeDefined());
    act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
    await user.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.tsv }));
    expect(await screen.findByText(strings.grid.copyFailed("denied"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: strings.grid.dismiss }));
    expect(screen.queryByText(strings.grid.copyFailed("denied"))).toBeNull();
    act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
    await user.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.tsv }));
    expect(await screen.findByText(strings.grid.copyFailed("denied"))).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByText(strings.grid.copyFailed("denied"))).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("the Data | Structure toggle switches views and keeps both mounted", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  const v = strings.grid.view;
  expect(await screen.findByRole("tab", { name: v.data })).toHaveAttribute("aria-selected", "true");
  // The structure is only loaded once asked for.
  expect(screen.queryByTestId("structure")).toBeNull();
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));

  await user.click(screen.getByRole("tab", { name: v.structure }));
  expect(screen.getByRole("tab", { name: v.structure })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByTestId("structure")).toBeVisible();
  expect(screen.getByTestId("structure")).toHaveTextContent("order_lines");
  expect(screen.getByTestId("grid")).not.toBeVisible();

  await user.click(screen.getByRole("tab", { name: v.data }));
  expect(screen.getByTestId("grid")).toBeVisible();
  expect(screen.getByTestId("structure")).not.toBeVisible();
  // Neither view started over: same page, the pending edit kept, the structure mounted once.
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  expect(screen.getByText(strings.grid.pendingCount(1))).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: v.structure }));
  expect(structureMounts).toBe(1);
});

test("Alt+2 shows the structure and Alt+1 the data, not while typing or with a modal", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  const v = strings.grid.view;
  const selected = (name: string) => screen.getByRole("tab", { name }).getAttribute("aria-selected");
  await screen.findByTestId("grid");

  await user.keyboard("{Alt>}2{/Alt}");
  expect(selected(v.structure)).toBe("true");
  expect(screen.getByTestId("structure")).toBeVisible();
  await user.keyboard("{Alt>}1{/Alt}");
  expect(selected(v.data)).toBe("true");
  expect(screen.getByTestId("grid")).toBeVisible();

  // Other modifiers: not this shortcut.
  await user.keyboard("{Control>}{Alt>}2{/Alt}{/Control}");
  expect(selected(v.data)).toBe("true");
  // Typing in a field (Option+2 types a character on macOS).
  await user.click(screen.getByRole("textbox", { name: strings.filters.quickLabel }));
  await user.keyboard("{Alt>}2{/Alt}");
  expect(selected(v.data)).toBe("true");
  (document.activeElement as HTMLElement).blur();
  // A modal is open.
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.appendChild(modal);
  await user.keyboard("{Alt>}2{/Alt}");
  expect(selected(v.data)).toBe("true");
  modal.remove();
  await user.keyboard("{Alt>}2{/Alt}");
  expect(selected(v.structure)).toBe("true");
});

test("the structure follows the table shown after a foreign key jump", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  const { rerender } = render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await user.click(await screen.findByRole("tab", { name: strings.grid.view.structure }));
  rerender(
    <TableDataTab workspaceId="w1" tabId="t1" object={{ schema: "public", name: "orders" }} dialect="postgres" />,
  );
  expect(screen.getByTestId("structure")).toHaveTextContent("orders");
  expect(screen.getByRole("tab", { name: strings.grid.view.structure })).toHaveAttribute("aria-selected", "true");
});
