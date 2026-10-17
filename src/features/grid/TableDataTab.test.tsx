import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { CellValue, ResultSet, RowKey } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { usePendingChanges } from "../../stores/pendingChanges";
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
  useGridViews.setState({ views: {} });
  usePendingChanges.setState({ tabs: {}, blocked: {}, committing: {}, applied: {}, editorOpen: {} });
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo());
});

test("footer shows range with ≈ for estimates and pages forward", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(page(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 1234567 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
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
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
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
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
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
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
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
    error: { kind: "query", message: "the row changed or was deleted since it was loaded" },
  });
  pending().setCell("t1", key(0), "note", { t: "null" }, lines(1).rows[0], names);
  pending().toggleDelete("t1", key(2));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
  await userEvent.click(await screen.findByRole("button", { name: strings.grid.commit("Ctrl+S") }));
  expect(
    await screen.findByText(
      strings.grid.changeFailed(2, "the row changed or was deleted since it was loaded"),
    ),
  ).toBeInTheDocument();
  expect(pending().count("t1")).toBe(2);
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(grid?.editing?.model.rowState(2)).toBe("failed"));
});

test("paging and sorting are blocked while changes are pending", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  pending().toggleDelete("t1", key(0));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–300 of 900"));
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  act(() => grid!.onSort!("note"));
  expect(useGridViews.getState().getView("t1")).toEqual({ page: 0, sort: null });
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.discard }));
  expect(screen.queryByText(strings.grid.commitOrDiscardFirst)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
});

test("context menu: Set NULL on a cell and Delete row", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
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
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
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
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).truncated).toBe(true));
  await expect(grid!.editing!.loadFull(0, 3)).resolves.toBe("the whole text");
  expect(ipc.cellValue).toHaveBeenCalledWith("w1", obj, key(0), "note");
});

test("Reload is blocked while changes are pending", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  pending().toggleDelete("t1", key(0));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("Rows 1–2 of 2"));
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(screen.getByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
});

test("Duplicate row copies the pending edits of the row", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
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
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} />);
  await waitFor(() => expect(grid?.editing).toBeDefined());
  act(() => grid!.editing!.onEditorOpen(true));
  expect(pending().editorOpen.t1).toBe(true);
  act(() => grid!.editing!.onEditorOpen(false));
  expect(pending().editorOpen.t1).toBe(false);
});
