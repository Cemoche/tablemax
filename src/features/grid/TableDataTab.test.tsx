import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { CellValue, ForeignKeyInfo, ResultSet, RowKey } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { useGridViews } from "../../stores/gridViews";
import { usePendingChanges } from "../../stores/pendingChanges";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { tableInfo } from "../../test/tableInfo";
import type { DataGridProps } from "./DataGrid";
import { useNavigationShortcuts } from "../workspace/navigation";
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
const commitName = strings.toolbar.commit;
/**
 * The toolbar's Commit and Discard (features/chrome/AppToolbar, tested there): the edit
 * strip above the grid is gone (#103), the tab is driven through the pending changes store.
 */
function Toolbar({ tabId = "t1", workspaceId = "w1" }: { tabId?: string; workspaceId?: string }) {
  const count = usePendingChanges((s) => s.count(tabId));
  return (
    <>
      <button type="button" disabled={count === 0} onClick={() => void pending().commit(tabId, workspaceId, obj)}>
        {commitName}
      </button>
      <button type="button" disabled={count === 0} onClick={() => pending().discard(tabId)}>
        {strings.toolbar.discard}
      </button>
    </>
  );
}
const discard = (tabId = "t1") => act(() => pending().discard(tabId));
/** The toolbar's row details button (features/chrome) acts through the chrome store. */
const toggleDetails = (tabId = "t1") => act(() => useChrome.getState().toggleRowDetails(tabId));
const detailsOpen = (tabId = "t1") => useChrome.getState().rowDetails[tabId] === true;

beforeEach(() => {
  vi.resetAllMocks();
  grid = null;
  structureMounts = 0;
  useGridViews.setState({ views: {}, trails: {}, layouts: {} });
  usePendingChanges.setState({
    tabs: {},
    blocked: {},
    committing: {},
    committingIn: {},
    confirming: {},
    applied: {},
    editorOpen: {},
    awaitingReload: {},
    epoch: {},
  });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useChrome.setState({ rowDetails: {}, reloads: {}, previews: {}, paletteRequest: null, tableViews: {} });
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo());
  vi.mocked(ipc.changesPreview).mockResolvedValue([]);
});

test("footer shows range with ≈ for estimates and pages forward", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(page(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 1234567 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() =>
    expect(screen.getByTestId("footer-range")).toHaveTextContent("1–300 of ≈ 1,234,567 rows"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(screen.getByTestId("footer-range")).toHaveTextContent("301–600 of ≈ 1,234,567 rows"),
  );
  expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
});

test("centre_text: the selected rows' count, else the row count (the range while the table spans pages)", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(415));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 415 });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, pageSize: 1000 } });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  const centre = () => screen.getByTestId("footer-range");
  // Everything on one page: the row count alone.
  await waitFor(() => expect(centre()).toHaveTextContent(/^415 rows$/));
  act(() => grid!.onSelectedRows!(1));
  expect(centre()).toHaveTextContent(/^1 of 415 rows selected$/);
  act(() => grid!.onSelectedRows!(3));
  expect(centre()).toHaveTextContent(/^3 of 415 rows selected$/);
  // A pending new row is one more row of the grid.
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  act(() => grid!.onSelectedRows!(1));
  expect(centre()).toHaveTextContent(/^1 of 416 rows selected$/);
  act(() => grid!.onSelectedRows!(0));
  expect(centre()).toHaveTextContent(/^415 rows$/);
});

test("the page size comes from the settings (request and range label)", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, pageSize: 50 } });
  vi.mocked(ipc.tablePage).mockResolvedValue(page(50));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–50 of 900 rows"));
  expect(ipc.tablePage).toHaveBeenCalledWith("w1", expect.objectContaining({ limit: 50, offset: 0 }));
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("51–100 of 900 rows"));
  expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ limit: 50, offset: 50 }));
});

test("a new page size is adopted at page 0 when nothing is pending", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(page(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–300 of 900 rows"));
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("301–600 of 900 rows"));
  vi.mocked(ipc.tablePage).mockClear();
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, pageSize: 100 } }));
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ limit: 100, offset: 0 })),
  );
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  expect(useGridViews.getState().getView("t1").page).toBe(0);
});

test("a new page size waits for pending changes to be discarded", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  pending().toggleDelete("t1", obj, key(0));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–300 of 900 rows"));
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, pageSize: 100 } }));
  await act(async () => {});
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("footer-range")).toHaveTextContent("1–300 of 900 rows");
  discard();
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ limit: 100, offset: 0 })),
  );
});

test("a latched page size survives a tab remount while changes are pending, until they are discarded", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  const ui = <TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />;
  const first = render(ui);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–300 of 900 rows"));
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("301–600 of 900 rows"));
  pending().toggleDelete("t1", obj, key(0));
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, pageSize: 50 } }));
  first.unmount();
  vi.mocked(ipc.tablePage).mockClear();
  render(ui);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("301–600 of 900 rows"));
  expect(ipc.tablePage).toHaveBeenCalledWith("w1", expect.objectContaining({ limit: 300, offset: 300 }));
  expect(ipc.tablePage).not.toHaveBeenCalledWith("w1", expect.objectContaining({ limit: 50 }));
  discard();
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ limit: 50, offset: 0 })),
  );
});

test("after a commit the tab adopts the changed page size at page 0 with a single fetch", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  vi.mocked(ipc.changesApply).mockResolvedValue({ applied: true, affected: [1], failedIndex: null, error: null });
  pending().toggleDelete("t1", obj, key(0));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–300 of 900 rows"));
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, pageSize: 100 } }));
  await act(async () => {});
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  vi.mocked(ipc.tablePage).mockClear();
  await act(() => pending().commit("t1", "w1", obj));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalled());
  await act(async () => {});
  const limits = vi.mocked(ipc.tablePage).mock.calls.map((c) => [c[1].limit, c[1].offset]);
  expect(limits).toEqual([[100, 0]]);
});

test("error shows message with Retry; connectionLost hints", async () => {
  vi.mocked(ipc.tablePage).mockRejectedValueOnce({ kind: "connectionLost", message: "server gone" });
  vi.mocked(ipc.tablePage).mockResolvedValue(page(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  expect(await screen.findByText("server gone")).toBeInTheDocument();
  expect(screen.getByText(strings.grid.reopenHint)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByTestId("footer-range")).toHaveTextContent("1 row");
});

test("a read-only table shows why and offers no + Row", async () => {
  vi.mocked(ipc.tableInfo).mockResolvedValue(tableInfo({ rowKey: null, primaryKey: [] }));
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  expect(await screen.findByText(strings.grid.readOnlyNoKey)).toBeInTheDocument();
  expect(ipc.tableInfo).toHaveBeenCalledWith("w1", obj, false);
  expect(screen.queryByRole("button", { name: strings.grid.addRow })).toBeNull();
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).editable).toBe(false));
});

test("the view switch names the effective shortcuts", async () => {
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      keymap: {
        "grid.rowDetails": "Alt+I",
        "grid.viewData": "Alt+7",
        "grid.viewStructure": "Alt+8",
      },
    },
  });
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(1));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await screen.findByTestId("grid");
  expect(screen.getByRole("tab", { name: strings.grid.view.data })).toHaveAttribute("data-tooltip-key", "Alt+7");
  expect(screen.getByRole("tab", { name: strings.grid.view.structure })).toHaveAttribute("data-tooltip-key", "Alt+8");
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
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  // No edit strip above the grid (#103): the toolbar commits.
  expect(screen.queryByRole("button", { name: /commit/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  expect(pending().count("t1")).toBe(2);
  const changes = pending().toChanges("t1");
  expect(changes).toEqual([
    { kind: "update", key: key(1), set: [["note", { t: "text", v: "changed" }]] },
    { kind: "insert", values: [] },
  ]);
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  await act(() => pending().commit("t1", "w1", obj));
  expect(ipc.changesApply).toHaveBeenCalledWith("w1", obj, changes, false);
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  expect(ipc.tableCount).toHaveBeenCalledTimes(2);
  expect(pending().count("t1")).toBe(0);
});

test("why a cell cannot be edited still shows above the grid, without the edit strip (#103)", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 4).editable).toBe(false));
  expect(screen.queryByText(strings.grid.generatedColumn)).toBeNull();
  act(() => grid!.editing!.onActivate(0, 4));
  expect(screen.getByRole("status")).toHaveTextContent(strings.grid.generatedColumn);
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
  await screen.findByTestId("grid");
  await act(() => pending().commit("t1", "w1", obj));
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
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–300 of 900 rows"));
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  act(() => grid!.onSort!("note"));
  expect(useGridViews.getState().getView("t1")).toEqual({ page: 0, sort: null, filters: [], pageSize: 300 });
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  discard();
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
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("2 rows"));
  // The toolbar's Reload (Mod+R) asks the tab through the chrome store.
  act(() => useChrome.getState().requestReload("t1"));
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
  toggleDetails();
  expect(detailsOpen()).toBe(true);
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
  await userEvent.keyboard("{Control>} {/Control}");
  expect(screen.queryByRole("complementary", { name: strings.grid.rowDetails })).toBeNull();
  await userEvent.keyboard("{Control>} {/Control}");
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
  toggleDetails();
  act(() => grid!.editing!.onSelect(1));
  const note = () => screen.getByLabelText("note") as HTMLTextAreaElement;
  await userEvent.type(note(), "!");
  expect(note()).toHaveFocus();
  // Mod+S while the field still has the focus: the typed text is already pending.
  await act(() => pending().commit("t1", "w1", obj));
  expect(ipc.changesApply).toHaveBeenCalledWith(
    "w1",
    obj,
    [{ kind: "update", key: key(1), set: [["note", { t: "text", v: "note 1!" }]] }],
    false,
  );
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
  toggleDetails();
  act(() => grid!.editing!.onSelect(1));
  expect((screen.getByLabelText("note") as HTMLTextAreaElement).value).toBe("note 1");
  // The toolbar's Reload (Mod+R) asks the tab through the chrome store.
  act(() => useChrome.getState().requestReload("t1"));
  await waitFor(() => expect(screen.getByText(strings.grid.rowDetailsEmpty)).toBeInTheDocument());
  expect(grid!.editing!.selectedRow).toBeNull();
});

test("+ Row moves the grid selection with the selected record", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  toggleDetails();
  act(() => grid!.editing!.onSelect(1));
  expect(grid!.editing!.selectedRow).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  expect(grid!.editing!.selectedRow).toBe(2);
  expect((screen.getByLabelText("note") as HTMLTextAreaElement).value).toBe("note 1");
});

test("the filter bar reloads page 0 filtered and a capped count shows 500,000+", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("3 rows"));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 500000 });
  // Closed at first (nothing applied); the Filters button opens it with the focus in it.
  expect(screen.queryByRole("region", { name: strings.filters.barLabel })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: strings.filters.button(0) }));
  expect(screen.getByRole("combobox", { name: strings.filters.columnLabel(1) })).toHaveFocus();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: strings.filters.columnLabel(1) }), "note");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: strings.filters.opLabel(1) }), "contains");
  await userEvent.type(screen.getByRole("textbox", { name: strings.filters.valueLabel(1) }), "x{Enter}");
  const filters = [{ column: "note", op: "contains", values: ["x"] }];
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 0, filters })),
  );
  expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", obj, filters, "and");
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–3 of 500,000+ rows"));
  expect(screen.getByRole("button", { name: strings.filters.button(1) })).toBeInTheDocument();
});

test("sql_preview: the filter bar's SQL asks the backend for the page's WHERE of the checked rows, shown with its values", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  vi.mocked(ipc.filtersPreviewSql).mockResolvedValue({
    sql: 'WHERE "line" = CAST($1::text AS integer)',
    display: `WHERE "line" = CAST('1'::text AS integer)`,
  });
  const one = [{ column: "line", op: "eq" as const, values: ["1"] }];
  useGridViews.getState().setView("t1", { filters: one });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await screen.findByRole("region", { name: strings.filters.barLabel });
  await userEvent.click(screen.getByRole("button", { name: strings.filters.sql }));
  const dialog = await screen.findByRole("dialog", { name: strings.filters.sqlPreviewLabel });
  expect(ipc.filtersPreviewSql).toHaveBeenCalledWith("w1", obj, one, "and");
  expect(await within(dialog).findByText(`WHERE "line" = CAST('1'::text AS integer)`)).toBeInTheDocument();
  // Escape closes the preview only, not the bar.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("region", { name: strings.filters.barLabel })).toBeInTheDocument();
  // Ctrl+F from inside the preview hides the bar; reopened, the preview is not back.
  await userEvent.click(screen.getByRole("button", { name: strings.filters.sql }));
  await screen.findByRole("dialog");
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(screen.queryByRole("region", { name: strings.filters.barLabel })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: strings.filters.button(1) }));
  expect(screen.getByRole("region", { name: strings.filters.barLabel })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("apply_all_and_or: Apply All with OR reaches the page and the count", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  const two = [
    { column: "line", op: "eq" as const, values: ["1"] },
    { column: "line", op: "eq" as const, values: ["2"] },
  ];
  useGridViews.getState().setView("t1", { filters: two });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  // Applied filters open the bar (without taking the focus).
  const bar = await screen.findByRole("region", { name: strings.filters.barLabel });
  expect(bar).not.toContainElement(document.activeElement as HTMLElement);
  // OR from Apply All's ⌄ menu (#103).
  await userEvent.click(screen.getByRole("button", { name: strings.filters.combineButton(strings.filters.combineAnd) }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: strings.filters.applyAllWith(strings.filters.combineOr) }));
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ filters: two, combine: "or" })),
  );
  expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", obj, two, "or");
  // A quick filter from the cell menu would widen an OR: it replaces the filters.
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.filterEquals("note", "note 1") }));
  expect(useGridViews.getState().getView("t1")).toMatchObject({
    filters: [{ column: "note", op: "eq", values: ["note 1"] }],
  });
  expect(useGridViews.getState().getView("t1").combine ?? "and").toBe("and");
});

test("a filter change with pending changes is blocked like a page change", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await userEvent.click(await screen.findByRole("button", { name: strings.grid.addRow }));
  await userEvent.click(screen.getByRole("button", { name: strings.filters.button(0) }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: strings.filters.columnLabel(1) }), "id");
  const value = screen.getByRole("textbox", { name: strings.filters.valueLabel(1) });
  await userEvent.type(value, "1{Enter}");
  expect(await screen.findByText(strings.grid.commitOrDiscardFirst)).toBeInTheDocument();
  expect(value).toHaveValue("1");
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
        status: "connected",
        database: null,
        schemas: ["public"],
        currentSchema: "public",
        tabs: [{ id: "t1", kind: "table", object: obj, title: obj.name, preview: false }],
        activeTabId: "t1",
        mru: ["t1"],
      },
    ],
    activeWorkspaceId: "w1",
  });
}
/** The store's tab t1, with the workspace's Back / Forward keys (Alt+← follows the trail). */
function StoreTab() {
  const tab = useWorkspaces((s) => s.workspaces[0].tabs[0]);
  useNavigationShortcuts("w1", true);
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
      combine: "and",
    }),
  );
  expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", ordersRef, filters, "and");
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
  toggleDetails();
  act(() => grid!.editing!.onSelect(0));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.openReferencedIn("orders") }));
  await waitFor(() => expect(theTab()).toMatchObject({ object: ordersRef }));
  expect(detailsOpen()).toBe(true);
});

/** A clipboard holding the last text written (jsdom has none). */
function stubClipboard() {
  const clip = { text: "", writeText: vi.fn(async (t: string) => void (clip.text = t)) };
  Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
  return clip;
}

test("Copy rows as CSV + header / SQL INSERT copies whole rows as displayed, without new rows", async () => {
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
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.csvHeader }));
  await waitFor(() =>
    expect(clip.text).toBe(
      "id,order_id,line,note,total,data\r\n100,42,0,note 0,1.50,\r\n101,42,1,it's edited,1.50,",
    ),
  );
  expect(screen.getByText(strings.grid.copySkippedInserts(1))).toBeInTheDocument();
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.csv }));
  await waitFor(() => expect(clip.text).toBe("100,42,0,note 0,1.50,\r\n101,42,1,it's edited,1.50,"));
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.insert }));
  await waitFor(() =>
    expect(clip.text).toBe(
      `INSERT INTO "public"."order_lines" ("id", "order_id", "line", "note", "total", "data") VALUES (100, 42, 0, 'note 0', '1.50', NULL);\n` +
        `INSERT INTO "public"."order_lines" ("id", "order_id", "line", "note", "total", "data") VALUES (101, 42, 1, 'it''s edited', '1.50', NULL);`,
    ),
  );
  // Copy selected cells: only the selected cells, tab-separated, no header.
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.copyCells }));
  await waitFor(() => expect(clip.text).toBe("0\tnote 0\n1\tit's edited"));
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
    expect(clip.text).toBe(
      '[\n  {\n    "id": 101,\n    "order_id": 42,\n    "line": 1,\n    "note": "note 1",\n    "total": "1.50",\n    "data": null\n  }\n]',
    ),
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
  expect(pending().count("t1")).toBe(1);
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
  await user.click(screen.getByRole("button", { name: strings.filters.button(0) }));
  await user.click(screen.getByRole("textbox", { name: strings.filters.valueLabel(1) }));
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

test("index_view_key: Alt+3 shows the indexes as their own view, from the table info already cached", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.tableInfo).mockResolvedValue(
    tableInfo({ indexes: [{ name: "lines_pkey", columns: ["order_id", "line"], unique: true, primary: true, definition: null }] }),
  );
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  const v = strings.grid.view;
  const selected = (name: string) => screen.getByRole("tab", { name }).getAttribute("aria-selected");
  await screen.findByTestId("grid");
  // Not mounted before it is first shown.
  expect(screen.queryByRole("tabpanel", { name: v.index })).toBeNull();

  await user.keyboard("{Alt>}3{/Alt}");
  expect(selected(v.index)).toBe("true");
  const panel = screen.getByRole("tabpanel", { name: v.index });
  expect(panel).toBeVisible();
  expect(screen.getByRole("tab", { name: v.index })).toHaveAttribute("aria-controls", panel.id);
  expect(await within(panel).findByRole("table", { name: strings.structure.indexView.label })).toBeInTheDocument();
  expect(screen.getByTestId("grid")).not.toBeVisible();
  // Only the table info call (no other backend call), never refreshed.
  expect(vi.mocked(ipc.tableInfo).mock.calls.every(([, , refresh]) => refresh === false)).toBe(true);

  await user.keyboard("{Alt>}1{/Alt}");
  expect(selected(v.data)).toBe("true");
  expect(panel).not.toBeVisible();
  expect(screen.getByTestId("grid")).toBeVisible();
});

test("Alt+1 / Alt+2 never reach the focused grid (it would start a cell edit)", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  const el = await screen.findByTestId("grid");
  el.tabIndex = 0;
  el.focus();
  const gridKey = vi.fn();
  el.addEventListener("keydown", gridKey);
  await user.keyboard("{Alt>}2{/Alt}");
  expect(screen.getByRole("tab", { name: strings.grid.view.structure })).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Alt>}1{/Alt}");
  expect(screen.getByRole("tab", { name: strings.grid.view.data })).toHaveAttribute("aria-selected", "true");
  // Only the Alt presses themselves reached the grid, never the digits.
  expect(gridKey.mock.calls.map(([e]) => (e as KeyboardEvent).code)).not.toContain("Digit1");
  expect(gridKey.mock.calls.map(([e]) => (e as KeyboardEvent).code)).not.toContain("Digit2");
});

test("a held Alt+1 / Alt+2: the repeats never reach the grid (no type-to-edit) and are prevented", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  const el = await screen.findByTestId("grid");
  el.tabIndex = 0;
  el.focus();
  const gridKey = vi.fn();
  el.addEventListener("keydown", gridKey);
  const hold = (digit: string, repeat: boolean) => {
    const e = new KeyboardEvent("keydown", {
      code: `Digit${digit}`,
      key: digit,
      altKey: true,
      repeat,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      el.dispatchEvent(e);
    });
    return e;
  };
  hold("2", false);
  const repeats = [hold("2", true), hold("2", true), hold("1", true)];
  expect(repeats.every((e) => e.defaultPrevented)).toBe(true);
  expect(gridKey).not.toHaveBeenCalled();
  // The press switched; its repeats (even of Alt+1) did nothing more.
  expect(screen.getByRole("tab", { name: strings.grid.view.structure })).toHaveAttribute("aria-selected", "true");
});

test("space_toggles_row_detail: Ctrl+Space toggles the row details on the physical Space key; Space in the grid too", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await screen.findByTestId("grid");
  const press = (init: KeyboardEventInit) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  press({ code: "Space", key: " ", metaKey: true });
  expect(detailsOpen()).toBe(false);
  press({ code: "Space", key: " ", ctrlKey: true });
  expect(detailsOpen()).toBe(true);
  // Ctrl+I is now the add row key of the spec (Task 6), not the row details.
  press({ code: "KeyI", key: "i", ctrlKey: true });
  expect(detailsOpen()).toBe(true);
  // Space, from the grid (which has the focus then).
  act(() => grid!.onToggleDetails!());
  expect(detailsOpen()).toBe(false);
});

test("custom view and row details combinations work and the defaults no longer do", async () => {
  const user = userEvent.setup();
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      keymap: { "grid.viewStructure": "Alt+S", "grid.viewData": "Alt+D", "grid.rowDetails": "Mod+Shift+I" },
    },
  });
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await screen.findByTestId("grid");
  await user.keyboard("{Control>} {/Control}");
  expect(detailsOpen()).toBe(false);
  await user.keyboard("{Control>}{Shift>}i{/Shift}{/Control}");
  expect(detailsOpen()).toBe(true);
  const selected = (name: string) => screen.getByRole("tab", { name }).getAttribute("aria-selected");
  await user.keyboard("{Alt>}2{/Alt}");
  expect(selected(strings.grid.view.data)).toBe("true");
  await user.keyboard("{Alt>}s{/Alt}");
  expect(selected(strings.grid.view.structure)).toBe("true");
  await user.keyboard("{Alt>}d{/Alt}");
  expect(selected(strings.grid.view.data)).toBe("true");
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

test("TSV / CSV / JSON copies say how many values were truncated; INSERT does not", async () => {
  const clip = stubClipboard();
  const data = lines(2);
  data.rows[0][3] = { t: "longText", v: { preview: "abc", len: 20000 } };
  vi.mocked(ipc.tablePage).mockResolvedValue(data);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  const block = { rows: [0, 1], cols: [2, 3] };
  for (const f of ["tsv", "csv", "json"] as const) {
    act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, block));
    await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs[f] }));
    expect(await screen.findByText(strings.grid.copyTruncated(1))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: strings.grid.dismiss }));
  }
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.copyAs.insert }));
  await waitFor(() => expect(clip.text).toContain("-- truncated value"));
  expect(screen.queryByText(strings.grid.copyTruncated(1))).toBeNull();
});

test("a Duplicate row finishing while a menu is open: the menu still acts on its own record", async () => {
  const data = lines(2);
  data.rows[0][3] = { t: "longText", v: { preview: "abc", len: 20000 } };
  vi.mocked(ipc.tablePage).mockResolvedValue(data);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  let resolve: (v: CellValue) => void = () => {};
  vi.mocked(ipc.cellValue).mockReturnValue(new Promise<CellValue>((r) => (resolve = r)));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(0, 3, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.duplicateRow }));
  // A menu on line 1 (display row 1) while the duplicate still loads.
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5));
  // The duplicate lands above: line 1 is now display row 2.
  await act(async () => resolve({ t: "text", v: "full text" }));
  expect(grid!.editing!.model.rows[0].kind).toBe("insert");
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.setNull }));
  expect(pending().toChanges("t1")).toEqual([
    { kind: "update", key: key(1), set: [["note", { t: "null" }]] },
    expect.objectContaining({ kind: "insert" }),
  ]);
});

test("a menu open across a commit (Mod+S) and its reload closes", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesApply).mockResolvedValue({ applied: true, affected: [1], failedIndex: null, error: null });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(0, 3, "x"));
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5));
  expect(screen.getByRole("menuitem", { name: strings.grid.menu.setNull })).toBeInTheDocument();
  await act(() => pending().commit("t1", "w1", obj));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(pending().count("t1")).toBe(0);
});

test("the cell editor follows its record and closes when rows change", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  const id = grid!.editing!.rowIdAt(1)!;
  const before = grid!.editing!.rowSignature;
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  // New signature (the grid closes its editor); the record is found at its new row.
  expect(grid!.editing!.rowSignature).not.toBe(before);
  expect(grid!.editing!.rowById(id)).toBe(2);
  // A pending edit of a cell keeps the rows: same signature.
  const now = grid!.editing!.rowSignature;
  act(() => grid!.editing!.onEdit(2, 3, "x"));
  expect(grid!.editing!.rowSignature).toBe(now);
});

test("after a successful commit the grid stays locked until the reload lands", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValueOnce(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesApply).mockResolvedValue({ applied: true, affected: [1], failedIndex: null, error: null });
  let reloaded: (r: ResultSet) => void = () => {};
  vi.mocked(ipc.tablePage).mockReturnValueOnce(new Promise<ResultSet>((r) => (reloaded = r)));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await act(() => pending().commit("t1", "w1", obj));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  // The old page is still shown: nothing on it can be edited.
  expect(grid!.editing!.model.locked).toBe(true);
  expect(grid!.editing!.model.cell(1, 3).editable).toBe(false);
  expect(screen.getByRole("button", { name: strings.grid.addRow })).toBeDisabled();
  await act(async () => reloaded(lines(2)));
  await waitFor(() => expect(grid!.editing!.model.cell(1, 3).editable).toBe(true));
  expect(screen.getByRole("button", { name: strings.grid.addRow })).toBeEnabled();
});

test("a cancelled commit (the toolbar's Cancel) wrote nothing; the bottom bar says Committing… meanwhile", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  let reject: (e: unknown) => void = () => {};
  vi.mocked(ipc.changesApply).mockReturnValue(new Promise((_, r) => (reject = r)));
  vi.mocked(ipc.changesCancel).mockResolvedValue(undefined);
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  act(() => void pending().commit("t1", "w1", obj));
  expect(screen.getByTestId("footer-range")).toHaveTextContent(strings.grid.committing);
  expect(screen.getByTestId("footer-range")).toHaveAttribute("aria-busy", "true");
  await act(() => pending().cancelCommit("t1", "w1"));
  expect(ipc.changesCancel).toHaveBeenCalledWith("w1");
  await act(async () => reject({ kind: "cancelled", message: "commit cancelled" }));
  expect(screen.getByText(strings.grid.commitFailed(strings.grid.commitCancelled))).toBeInTheDocument();
  expect(screen.getByText(strings.grid.nothingWritten)).toBeInTheDocument();
  expect(pending().count("t1")).toBe(1);
});

test("a commit that lost its connection never claims nothing was written; reload, then commit again", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesApply).mockRejectedValueOnce({ kind: "connectionLost", message: "server gone" });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await act(() => pending().commit("t1", "w1", obj));
  expect(await screen.findByText(strings.grid.commitOutcomeUnknown)).toBeInTheDocument();
  expect(screen.queryByText(strings.grid.nothingWritten)).toBeNull();
  // The toolbar's Commit reads this flag (disabled until a reload).
  expect(pending().tabs.t1?.outcomeUnknown).toBe(true);
  expect(pending().count("t1")).toBe(1);
  // Reloading is allowed (paging is not); once the page is back, Commit works again.
  // The toolbar's Reload (Mod+R) asks the tab through the chrome store.
  act(() => useChrome.getState().requestReload("t1"));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(strings.grid.commitOutcomeUnknown)).toBeNull());
  expect(pending().tabs.t1?.outcomeUnknown).toBeFalsy();
  expect(pending().count("t1")).toBe(1);
});

test("with the structure shown, Alt+← and Ctrl+Space leave the hidden data view alone", async () => {
  const user = userEvent.setup();
  setTab();
  vi.mocked(ipc.tableInfo).mockResolvedValue(fkInfo());
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<StoreTab />);
  await waitFor(() => expect(grid?.editing?.linkAt(0, 1)).toBe(true));
  act(() => grid!.editing!.onOpenLink(0, 1));
  await waitFor(() => expect(theTab()).toMatchObject({ object: ordersRef }));
  await user.click(screen.getByRole("tab", { name: strings.grid.view.structure }));
  await user.keyboard("{Control>} {/Control}");
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  expect(detailsOpen()).toBe(false);
  expect(theTab()).toMatchObject({ object: ordersRef });
  // Back on the data view both work again.
  await user.click(screen.getByRole("tab", { name: strings.grid.view.data }));
  await user.keyboard("{Control>} {/Control}");
  expect(detailsOpen()).toBe(true);
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await waitFor(() => expect(theTab()).toMatchObject({ object: obj }));
});

const applied = { applied: true, affected: [1, 1], failedIndex: null, error: null };

function setWorkspace(envTag: "prod" | "local") {
  useWorkspaces.setState({
    workspaces: [
      {
        id: "w1",
        connectionId: "c1",
        name: "Billing",
        color: "swatch-1",
        envTag,
        dialect: "postgres",
        status: "connected",
        database: null,
        schemas: ["public"],
        currentSchema: "public",
        tabs: [{ id: "t1", kind: "table", object: obj, title: obj.name, preview: false }],
        activeTabId: "t1",
        mru: ["t1"],
      },
    ],
    activeWorkspaceId: "w1",
  });
}

/** A prod workspace, two pending changes, Commit refused until confirmed. */
async function refusedCommit() {
  setWorkspace("prod");
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  vi.mocked(ipc.changesApply).mockRejectedValueOnce({ kind: "confirmationRequired", message: "0,1" });
  render(
    <>
      <Toolbar />
      <TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />
    </>,
  );
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.addRow }));
  return pending().toChanges("t1");
}

test("a protected connection asks to confirm the commit, showing one SQL per change; Run resends the same list", async () => {
  const changes = await refusedCommit();
  vi.mocked(ipc.changesPreview).mockImplementation(async (_w, _o, list) =>
    list.length === 2 ? ["UPDATE order_lines SET note = 'changed'", "INSERT INTO order_lines DEFAULT VALUES"] : [],
  );
  await userEvent.click(screen.getByRole("button", { name: commitName }));
  const dialog = await screen.findByRole("dialog");
  expect(ipc.changesApply).toHaveBeenCalledWith("w1", obj, changes, false);
  expect(ipc.changesPreview).toHaveBeenLastCalledWith("w1", obj, changes);
  expect(within(dialog).getByText(strings.safety.dialogIntro("Billing", "PROD"))).toBeInTheDocument();
  expect(within(dialog).getByText("UPDATE order_lines SET note = 'changed'")).toBeInTheDocument();
  expect(within(dialog).getByText("INSERT INTO order_lines DEFAULT VALUES")).toBeInTheDocument();
  expect(within(dialog).getAllByText(strings.safety.needsConfirmation)).toHaveLength(2);
  // No failure shown for the refusal itself.
  expect(screen.queryByText(strings.grid.nothingWritten)).toBeNull();
  vi.mocked(ipc.changesApply).mockResolvedValueOnce(applied);
  await userEvent.click(within(dialog).getByRole("button", { name: strings.safety.confirmRun }));
  expect(ipc.changesApply).toHaveBeenCalledTimes(2);
  expect(ipc.changesApply).toHaveBeenLastCalledWith("w1", obj, changes, true);
  await waitFor(() => expect(pending().count("t1")).toBe(0));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Cancel in the commit confirmation applies nothing and keeps the changes", async () => {
  await refusedCommit();
  vi.mocked(ipc.changesPreview).mockResolvedValue(["a", "b"]);
  await userEvent.click(screen.getByRole("button", { name: commitName }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: strings.safety.confirmCancel }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ipc.changesApply).toHaveBeenCalledTimes(1);
  expect(pending().count("t1")).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: commitName })).toHaveFocus());
});

test("a failing preview for the confirmation shows its error and applies nothing", async () => {
  await refusedCommit();
  vi.mocked(ipc.changesPreview).mockRejectedValue({ kind: "query", message: "preview broke" });
  await userEvent.click(screen.getByRole("button", { name: commitName }));
  expect(
    await screen.findByText(strings.grid.commitFailed(strings.grid.confirmPreviewFailed("preview broke"))),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ipc.changesApply).toHaveBeenCalledTimes(1);
  expect(pending().count("t1")).toBe(2);
});

test("a commit started without the button (Mod+S) also ends in the confirmation", async () => {
  await refusedCommit();
  vi.mocked(ipc.changesPreview).mockResolvedValue(["a", "b"]);
  await act(() => pending().commit("t1", "w1", obj));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

test("an unprotected connection commits without a confirmation", async () => {
  setWorkspace("local");
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesApply).mockResolvedValue(applied);
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await act(() => pending().commit("t1", "w1", obj));
  await waitFor(() => expect(pending().count("t1")).toBe(0));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(ipc.changesApply).toHaveBeenCalledTimes(1);
});

test("Discard after an unknown outcome drops the edits, reloads, and stays blocked until the page is back", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValueOnce(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesApply).mockRejectedValueOnce({ kind: "connection", message: "outcome unknown" });
  let reloaded: (r: ResultSet) => void = () => {};
  vi.mocked(ipc.tablePage).mockReturnValueOnce(new Promise<ResultSet>((r) => (reloaded = r)));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await act(() => pending().commit("t1", "w1", obj));
  expect(await screen.findByText(strings.grid.commitOutcomeUnknown)).toBeInTheDocument();
  discard();
  expect(pending().count("t1")).toBe(0);
  // Still blocked: the warning stays and the page is reloaded.
  expect(screen.getByText(strings.grid.commitOutcomeUnknown)).toBeInTheDocument();
  expect(pending().guardReload("t1")).toBe(true);
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  act(() => grid!.editing!.onEdit(1, 3, "again"));
  await act(() => pending().commit("t1", "w1", obj));
  expect(ipc.changesApply).toHaveBeenCalledTimes(1);
  await act(async () => reloaded(lines(2)));
  await waitFor(() => expect(screen.queryByText(strings.grid.commitOutcomeUnknown)).toBeNull());
  expect(pending().tabs.t1?.outcomeUnknown).toBeFalsy();
});

test("a cancel that lands on the COMMIT shows the cause-neutral unknown-outcome text", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  vi.mocked(ipc.changesApply).mockRejectedValueOnce({ kind: "connection", message: "The commit was interrupted" });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onEdit(1, 3, "changed"));
  await act(() => pending().commit("t1", "w1", obj));
  const text = await screen.findByText(strings.grid.commitOutcomeUnknown);
  expect(text).toHaveTextContent(/interrupted/);
  expect(text).not.toHaveTextContent(/connection was lost/i);
});

test("Mod+S from the structure view shows the confirmation, visible and focused", async () => {
  await refusedCommit();
  vi.mocked(ipc.changesPreview).mockResolvedValue(["a", "b"]);
  await userEvent.click(screen.getByRole("tab", { name: strings.grid.view.structure }));
  await act(() => pending().commit("t1", "w1", obj));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toBeVisible();
  expect(within(dialog).getByRole("button", { name: strings.safety.confirmCancel })).toHaveFocus();
  await userEvent.click(within(dialog).getByRole("button", { name: strings.safety.confirmCancel }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pending().count("t1")).toBe(2);
});

test("after Run the focus comes back to what opened the confirmation (the toolbar's Commit) once the commit settled", async () => {
  await refusedCommit();
  vi.mocked(ipc.changesPreview).mockResolvedValue(["a", "b"]);
  await userEvent.click(screen.getByRole("button", { name: commitName }));
  const dialog = await screen.findByRole("dialog");
  vi.mocked(ipc.changesApply).mockResolvedValueOnce({
    applied: false,
    affected: [1, 0],
    failedIndex: null,
    error: { kind: "query", message: "deadlock detected" },
  });
  await userEvent.click(within(dialog).getByRole("button", { name: strings.safety.confirmRun }));
  expect(await screen.findByText(strings.grid.commitFailed("deadlock detected"))).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: commitName })).toHaveFocus());
});

test("after a successful Run the focus lands on + Row once the reload unlocks the tab (the toolbar's Commit is disabled)", async () => {
  await refusedCommit();
  vi.mocked(ipc.changesPreview).mockResolvedValue(["a", "b"]);
  let reloaded: (r: ResultSet) => void = () => {};
  vi.mocked(ipc.tablePage).mockReturnValueOnce(new Promise<ResultSet>((r) => (reloaded = r)));
  await userEvent.click(screen.getByRole("button", { name: commitName }));
  const dialog = await screen.findByRole("dialog");
  vi.mocked(ipc.changesApply).mockResolvedValueOnce(applied);
  await userEvent.click(within(dialog).getByRole("button", { name: strings.safety.confirmRun }));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: strings.grid.addRow })).not.toHaveFocus();
  await act(async () => reloaded(lines(3)));
  await waitFor(() => expect(screen.getByRole("button", { name: strings.grid.addRow })).toHaveFocus());
  expect(screen.getByRole("button", { name: commitName })).toBeDisabled();
});

test("Cancel of the commit confirmation raised from the structure view focuses the view toggle", async () => {
  await refusedCommit();
  vi.mocked(ipc.changesPreview).mockResolvedValue(["a", "b"]);
  await userEvent.click(screen.getByRole("tab", { name: strings.grid.view.structure }));
  // Mod+S with nothing focused: the opener is <body>, so only the explicit refocus can help.
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.body).toHaveFocus();
  await act(() => pending().commit("t1", "w1", obj));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: strings.safety.confirmCancel }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(screen.getByRole("tab", { name: strings.grid.view.structure })).toHaveFocus());
});

test("the toolbar's Reload and row details buttons act on the tab", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  const { unmount } = render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("2 rows"));
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  act(() => useChrome.getState().requestReload("t1"));
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  // Another tab's reload is not ours.
  act(() => useChrome.getState().requestReload("t2"));
  expect(ipc.tablePage).toHaveBeenCalledTimes(2);

  act(() => useChrome.getState().toggleRowDetails("t1"));
  expect(detailsOpen()).toBe(true);
  expect(screen.getByRole("complementary", { name: strings.grid.rowDetails })).toBeInTheDocument();
  // Closed again when the tab goes away (as before: the panel starts closed).
  unmount();
  expect(useChrome.getState().rowDetails.t1).toBeFalsy();
});

test("a tab keeps Structure when it is shown again (a workspace or tab switch unmounts it)", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  const first = render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await screen.findByTestId("grid");
  await userEvent.click(screen.getByRole("tab", { name: strings.grid.view.structure }));
  first.unmount();
  // Another tab of the same kind shows its own view (Data by default).
  const other = render(<TableDataTab workspaceId="w1" tabId="t2" object={obj} dialect="postgres" />);
  expect(screen.getByRole("tab", { name: strings.grid.view.data })).toHaveAttribute("aria-selected", "true");
  other.unmount();
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  expect(screen.getByRole("tab", { name: strings.grid.view.structure })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByTestId("structure")).toBeVisible();
});

test("cell_menu_items: Quick Look, Set value, copies, quick filters and the row actions", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5));
  const names = () => screen.getAllByRole("menuitem").map((i) => i.getAttribute("aria-label") ?? i.textContent);
  expect(names()).toEqual([
    strings.grid.menu.quickLook,
    strings.grid.menu.setNull,
    strings.grid.menu.setEmpty,
    strings.grid.menu.copyRows,
    strings.grid.copyAs.tsv,
    strings.grid.copyAs.csv,
    strings.grid.copyAs.csvHeader,
    strings.grid.copyAs.json,
    strings.grid.copyAs.markdown,
    strings.grid.copyAs.insert,
    strings.grid.menu.copyCells,
    strings.grid.menu.filterIsNull("note"),
    strings.grid.menu.filterEquals("note", "note 1"),
    strings.grid.menu.addRow,
    strings.grid.menu.duplicateRow,
    strings.grid.menu.deleteRow,
  ]);
  expect(screen.getByText(strings.grid.menu.setValue)).toBeInTheDocument();
  expect(screen.getByText(strings.grid.menu.copyRowsAs)).toBeInTheDocument();
  expect(screen.getByText(strings.grid.menu.quickFilter)).toBeInTheDocument();
  // The row number's menu: no cell entries.
  await userEvent.keyboard("{Escape}");
  act(() => grid!.editing!.onContextMenu(1, null, 5, 5));
  expect(names()).not.toContain(strings.grid.menu.quickLook);
  expect(names()).not.toContain(strings.grid.menu.setNull);
  expect(names()).toContain(strings.grid.menu.deleteRow);
});

test("Set value and Delete act on every selected row, through the pending changes", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5, { rows: [0, 1], cols: [3] }));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.setEmpty }));
  expect(pending().toChanges("t1")).toEqual([
    { kind: "update", key: key(0), set: [["note", { t: "text", v: "" }]] },
    { kind: "update", key: key(1), set: [["note", { t: "text", v: "" }]] },
  ]);
  act(() => grid!.editing!.onContextMenu(2, null, 5, 5, { rows: [1, 2], cols: [0, 1, 2, 3, 4, 5] }));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.deleteRows(2) }));
  expect(pending().toChanges("t1").filter((c) => c.kind === "delete")).toEqual([
    { kind: "delete", key: key(1) },
    { kind: "delete", key: key(2) },
  ]);
  // Every selected row is deleted: the entry restores them.
  act(() => grid!.editing!.onContextMenu(2, null, 5, 5, { rows: [1, 2], cols: [0, 1, 2, 3, 4, 5] }));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.restoreRows(2) }));
  expect(pending().toChanges("t1").filter((c) => c.kind === "delete")).toEqual([]);
});

test("grid keys: Delete and Ctrl+D act on the selected rows; Ctrl+Shift+C copies the selected cells", async () => {
  const clip = stubClipboard();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.onRowsAction!("delete", [0, 2]));
  expect(pending().toChanges("t1")).toEqual([
    { kind: "delete", key: key(0) },
    { kind: "delete", key: key(2) },
  ]);
  act(() => grid!.onRowsAction!("duplicate", [1]));
  await waitFor(() => expect(pending().toChanges("t1").filter((c) => c.kind === "insert")).toHaveLength(1));
  // The new row is display row 0 now: line 1 is row 2.
  act(() => grid!.onCopyCells!({ rows: [2], cols: [2, 3] }));
  await waitFor(() => expect(clip.text).toBe("1\tnote 1"));
});

test("Quick filter = value and IS NULL narrow the rows on the clicked column", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.filterEquals("note", "note 1") }));
  expect(useGridViews.getState().getView("t1").filters).toEqual([{ column: "note", op: "eq", values: ["note 1"] }]);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 5).value).toEqual({ t: "null" }));
  act(() => grid!.editing!.onContextMenu(0, 5, 5, 5));
  // NULL has no "= value" entry.
  expect(screen.queryByRole("menuitem", { name: strings.grid.menu.filterEquals("data", "") })).toBeNull();
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.filterIsNull("data") }));
  expect(useGridViews.getState().getView("t1").filters).toEqual([
    { column: "note", op: "eq", values: ["note 1"] },
    { column: "data", op: "isNull", values: [] },
  ]);
});

test("Quick Look shows the whole value of a truncated cell, then gives the focus back", async () => {
  const data = lines(1);
  data.rows[0][3] = { t: "longText", v: { preview: "abc", len: 20000 } };
  vi.mocked(ipc.tablePage).mockResolvedValue(data);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 1 });
  vi.mocked(ipc.cellValue).mockResolvedValue({ t: "json", v: '{"k":[1,2]}' });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(0, 3).editable).toBe(true));
  act(() => grid!.onQuickLook!(0, 3));
  const dialog = await screen.findByRole("dialog", { name: strings.grid.quickLook.title("note") });
  await waitFor(() => expect(dialog).toHaveTextContent('"k": ['));
  expect(ipc.cellValue).toHaveBeenCalledWith("w1", obj, key(0), "note");
  await userEvent.click(screen.getByRole("button", { name: strings.grid.quickLook.close }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the grid's header menu filters on a column and sorts in one direction", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing).toBeDefined());
  act(() => grid!.onSortTo!("note", "desc"));
  expect(useGridViews.getState().getView("t1").sort).toEqual(["note", "desc"]);
  act(() => grid!.onSortTo!("note", null));
  expect(useGridViews.getState().getView("t1").sort).toBeNull();
  act(() => grid!.onFilterColumn!("note"));
  // The filter bar opens on a row for that column, its value focused.
  expect(screen.getByRole("combobox", { name: strings.filters.columnLabel(1) })).toHaveValue("c:note");
  expect(screen.getByRole("textbox", { name: strings.filters.valueLabel(1) })).toHaveFocus();
  // Each table keeps its own column layout.
  expect(grid!.layoutKey).toBeTruthy();
});

test("with a column hidden, the row number menu of 3 selected rows acts on the 3 rows (fix 2)", async () => {
  const clip = stubClipboard();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 3 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => useGridViews.getState().setLayout(grid!.layoutKey!, { hidden: ["data"] }));
  // What the grid reports for 3 rows selected by their numbers: the 5 shown columns.
  const block = { rows: [0, 1, 2], cols: [0, 1, 2, 3, 4], wholeRows: true };
  act(() => grid!.editing!.onContextMenu(1, null, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.copyRows }));
  await waitFor(() =>
    expect(clip.text).toBe("100\t42\t0\tnote 0\t1.50\n101\t42\t1\tnote 1\t1.50\n102\t42\t2\tnote 2\t1.50"),
  );
  act(() => grid!.editing!.onContextMenu(1, null, 5, 5, block));
  await userEvent.click(screen.getByRole("menuitem", { name: strings.grid.menu.deleteRows(3) }));
  expect(pending().toChanges("t1")).toEqual([0, 1, 2].map((l) => ({ kind: "delete", key: key(l) })));
});

test("no '= value' quick filter on a PostgreSQL json column (json has no =); jsonb keeps it (fix 5)", async () => {
  const withType = (baseType: string) =>
    tableInfo({
      columns: tableInfo().columns.map((c) => (c.name === "note" ? { ...c, typeName: baseType, baseType } : c)),
    });
  vi.mocked(ipc.tableInfo).mockResolvedValue(withType("json"));
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  const view = render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.info).not.toBeNull());
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5));
  expect(screen.getByRole("menuitem", { name: strings.grid.menu.filterIsNull("note") })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: strings.grid.menu.filterEquals("note", "note 1") })).toBeNull();
  view.unmount();
  vi.mocked(ipc.tableInfo).mockResolvedValue(withType("jsonb"));
  render(<TableDataTab workspaceId="w1" tabId="t2" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.info?.columns[3].baseType).toBe("jsonb"));
  act(() => grid!.editing!.onContextMenu(1, 3, 5, 5));
  expect(screen.getByRole("menuitem", { name: strings.grid.menu.filterEquals("note", "note 1") })).toBeInTheDocument();
});

test("duplicating several rows inserts them in row order, even when one must load a value first (fix 8)", async () => {
  const data = lines(2);
  data.rows[0][3] = { t: "longText", v: { preview: "abc", len: 20000 } };
  vi.mocked(ipc.tablePage).mockResolvedValue(data);
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  let resolve: (v: CellValue) => void = () => {};
  vi.mocked(ipc.cellValue).mockReturnValue(new Promise<CellValue>((r) => (resolve = r)));
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  act(() => grid!.onRowsAction!("duplicate", [0, 1]));
  // Row 1 waits for row 0, whose value is still loading.
  expect(pending().count("t1")).toBe(0);
  await act(async () => resolve({ t: "text", v: "full text" }));
  await waitFor(() => expect(pending().count("t1")).toBe(2));
  const lines_ = pending()
    .toChanges("t1")
    .map((c) => (c.kind === "insert" ? c.values.find(([n]) => n === "line")?.[1] : null));
  expect(lines_).toEqual([
    { t: "text", v: "0" },
    { t: "text", v: "1" },
  ]);
});

test("bottom bar keys: Ctrl+F opens the filters with the focus, closes them from inside; Alt+F Columns; Ctrl+I + Row", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  const user = userEvent.setup();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  const el = screen.getByTestId("grid");
  el.tabIndex = 0;
  el.focus();
  const bar = () => screen.queryByRole("region", { name: strings.filters.barLabel });
  await user.keyboard("{Control>}f{/Control}");
  expect(bar()).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: strings.filters.columnLabel(1) })).toHaveFocus();
  expect(screen.getByRole("button", { name: strings.filters.button(0) })).toHaveAttribute("aria-expanded", "true");
  // Inside the bar Ctrl+F closes it; the grid gets the focus back.
  await user.keyboard("{Control>}f{/Control}");
  expect(bar()).toBeNull();
  expect(el).toHaveFocus();
  // Escape hides it too, even with a value typed; reopened, the typed row is still there (#103).
  await user.keyboard("{Control>}f{/Control}");
  await user.type(screen.getByRole("textbox", { name: strings.filters.valueLabel(1) }), "abc");
  await user.keyboard("{Escape}");
  expect(bar()).toBeNull();
  expect(el).toHaveFocus();
  await user.keyboard("{Control>}f{/Control}");
  expect(screen.getByRole("textbox", { name: strings.filters.valueLabel(1) })).toHaveValue("abc");
  await user.keyboard("{Escape}");
  expect(el).toHaveFocus();

  // Columns: Alt+F off macOS (Ctrl+Alt+F is AltGr+F there, #102).
  await user.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{Alt>}f{/Alt}");
  expect(screen.getByRole("dialog", { name: strings.grid.columnsPopover.label })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: strings.grid.columns })).toHaveFocus();

  // + Row from the grid; in the filter bar Ctrl+I adds a filter row instead.
  el.focus();
  await user.keyboard("{Control>}i{/Control}");
  expect(pending().count("t1")).toBe(1);
  await user.click(screen.getByRole("button", { name: strings.filters.button(0) }));
  await user.click(screen.getByRole("textbox", { name: strings.filters.valueLabel(1) }));
  await user.keyboard("{Control>}i{/Control}");
  expect(pending().count("t1")).toBe(1);
  expect(screen.getAllByRole("checkbox", { name: /^Use condition/ })).toHaveLength(2);

  // Alt+2 / Alt+1 switch the view; off macOS Ctrl+Alt+] / [ do not (AltGr, #102).
  el.focus();
  await user.keyboard("{Control>}{Alt>}[BracketRight]{/Alt}{/Control}");
  expect(screen.getByRole("tab", { name: strings.grid.view.data })).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Alt>}2{/Alt}");
  expect(screen.getByRole("tab", { name: strings.grid.view.structure })).toHaveAttribute("aria-selected", "true");
  // The structure view keeps only the view switch in the bar.
  expect(screen.queryByRole("button", { name: strings.grid.columns })).toBeNull();
  await user.keyboard("{Alt>}1{/Alt}");
  expect(screen.getByRole("tab", { name: strings.grid.view.data })).toHaveAttribute("aria-selected", "true");
});

test("Ctrl+B in the open filter bar toggles the focused row, in the whole table tab (#102)", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  const user = userEvent.setup();
  vi.mocked(ipc.tablePage).mockResolvedValue(lines(2));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 2 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(grid?.editing?.model.cell(1, 3).editable).toBe(true));
  const el = screen.getByTestId("grid");
  el.tabIndex = 0;
  el.focus();
  await user.keyboard("{Control>}f{/Control}");
  const check = () => screen.getByRole("checkbox", { name: strings.filters.enabledLabel(1) });
  const fields = [
    screen.getByRole("combobox", { name: strings.filters.columnLabel(1) }),
    screen.getByRole("combobox", { name: strings.filters.opLabel(1) }),
    screen.getByRole("textbox", { name: strings.filters.valueLabel(1) }),
    check(),
  ];
  expect(fields[0]).toHaveFocus();
  for (const f of fields) {
    f.focus();
    await user.keyboard("{Control>}b{/Control}");
    expect(check()).not.toBeChecked();
    await user.keyboard("{Control>}b{/Control}");
    expect(check()).toBeChecked();
  }
});

test("page_popover_offset_limit: Go loads that offset and limit; the grid's Ctrl+→ / Ctrl+← page from there", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(page(100));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 900 });
  render(<TableDataTab workspaceId="w1" tabId="t1" object={obj} dialect="postgres" />);
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("1–100 of 900 rows"));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.pageSettings }));
  const p = strings.grid.pagePopover;
  await userEvent.clear(screen.getByRole("textbox", { name: p.offset }));
  await userEvent.type(screen.getByRole("textbox", { name: p.offset }), "250");
  await userEvent.clear(screen.getByRole("textbox", { name: p.limit }));
  await userEvent.type(screen.getByRole("textbox", { name: p.limit }), "100{Enter}");
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 250, limit: 100 })),
  );
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("251–350 of 900 rows"));
  act(() => grid!.onPageKey!("next"));
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 350, limit: 100 })),
  );
  await waitFor(() => expect(screen.getByTestId("footer-range")).toHaveTextContent("351–450"));
  act(() => grid!.onPageKey!("previous"));
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 250, limit: 100 })),
  );
});
