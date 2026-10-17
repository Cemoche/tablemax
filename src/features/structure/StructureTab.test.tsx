import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { TableInfo } from "../../lib/types";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { buildEditorTheme } from "../editor/SqlEditor";
import { StructureTab } from "./StructureTab";

vi.mock("../../lib/ipc");
vi.mock("../editor/SqlEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../editor/SqlEditor")>();
  return { ...actual, buildEditorTheme: vi.fn(actual.buildEditorTheme) };
});

const s = strings.structure;
const object = { schema: "public", name: "orders" };
const col = (name: string, over: Partial<TableInfo["columns"][number]> = {}) => ({
  name,
  typeName: "integer",
  baseType: "integer",
  nullable: false,
  default: null,
  autoIncrement: false,
  generated: false,
  binary: false,
  comment: null,
  ...over,
});
const info: TableInfo = {
  object,
  kind: "table",
  columns: [
    col("id", { autoIncrement: true }),
    col("user_id"),
    col("note", { typeName: "text", nullable: true, default: "'n/a'::text", comment: "free text" }),
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "orders_pkey", columns: ["id"], unique: true, primary: true, definition: "CREATE UNIQUE INDEX orders_pkey ON orders (id)" },
    { name: "orders_user_uq", columns: ["user_id", "note"], unique: true, primary: false, definition: null },
    { name: "orders_note_idx", columns: ["note"], unique: false, primary: false, definition: null },
  ],
  foreignKeys: [
    {
      name: "orders_user_fk",
      columns: ["user_id"],
      refSchema: "auth",
      refTable: "users",
      refColumns: ["id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
  ],
  rowKey: ["id"],
  hasRowid: false,
};
const workspace: Workspace = {
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
  tabs: [],
  activeTabId: null,
  mru: [],
};
const DDL = "CREATE TABLE orders (id integer PRIMARY KEY)";

const renderTab = () => render(<StructureTab workspaceId="w1" object={object} dialect="postgres" />);
const tab = (name: string) => screen.findByRole("tab", { name });

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
  vi.mocked(ipc.tableInfo).mockResolvedValue(info);
  vi.mocked(ipc.tableDdl).mockResolvedValue(DDL);
});

test("loads info with refresh=false and shows a loading state first", async () => {
  renderTab();
  expect(screen.getByText(s.loading)).toBeInTheDocument();
  expect(ipc.tableInfo).toHaveBeenCalledWith("w1", object, false);
  expect(ipc.tableDdl).toHaveBeenCalledWith("w1", object);
  await screen.findByRole("table", { name: s.tabs.columns });
  expect(screen.queryByText(s.loading)).toBeNull();
});

test("Columns marks primary and foreign key columns and shows the details", async () => {
  renderTab();
  const table = await screen.findByRole("table", { name: s.tabs.columns });
  const rows = within(table).getAllByRole("row");
  const id = within(rows[1]);
  expect(id.getByLabelText(s.primaryKeyLabel)).toBeInTheDocument();
  expect(id.getByText(s.autoIncrement)).toBeInTheDocument();
  const userId = within(rows[2]);
  expect(userId.getByLabelText(s.foreignKeyLabel)).toBeInTheDocument();
  expect(userId.queryByLabelText(s.primaryKeyLabel)).toBeNull();
  const note = within(rows[3]);
  expect(note.getByText("'n/a'::text")).toBeInTheDocument();
  expect(note.getByText("free text")).toBeInTheDocument();
  expect(note.getByText(s.yes)).toBeInTheDocument();
});

test("Indexes shows unique and primary indexes", async () => {
  renderTab();
  await userEvent.click(await tab(s.tabs.indexes));
  const table = screen.getByRole("table", { name: s.tabs.indexes });
  const pk = within(within(table).getByText("orders_pkey").closest("tr")!);
  expect(pk.getByText(s.primary)).toBeInTheDocument();
  expect(pk.getByText("CREATE UNIQUE INDEX orders_pkey ON orders (id)")).toBeInTheDocument();
  const uq = within(within(table).getByText("orders_user_uq").closest("tr")!);
  expect(uq.getByText(s.unique)).toBeInTheDocument();
  expect(uq.getByText("user_id, note")).toBeInTheDocument();
  const plain = within(within(table).getByText("orders_note_idx").closest("tr")!);
  expect(plain.queryByText(s.unique)).toBeNull();
});

test("Foreign keys show actions and the link opens the referenced table", async () => {
  renderTab();
  await userEvent.click(await tab(s.tabs.foreignKeys));
  const table = screen.getByRole("table", { name: s.tabs.foreignKeys });
  expect(within(table).getByText("CASCADE")).toBeInTheDocument();
  expect(within(table).getByText("NO ACTION")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: s.openReferenced("auth.users") }));
  const tabs = useWorkspaces.getState().workspaces[0].tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ kind: "table", title: "users" });
});

test("empty indexes and foreign keys show a message", async () => {
  vi.mocked(ipc.tableInfo).mockResolvedValue({ ...info, indexes: [], foreignKeys: [] });
  renderTab();
  await userEvent.click(await tab(s.tabs.indexes));
  expect(screen.getByText(s.noIndexes)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: s.tabs.foreignKeys }));
  expect(screen.getByText(s.noForeignKeys)).toBeInTheDocument();
});

test("DDL is shown read-only and Copy writes it to the clipboard", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText");
  renderTab();
  await user.click(await tab(s.tabs.ddl));
  await waitFor(() => expect(screen.getByLabelText(s.ddlLabel)).toHaveTextContent(DDL));
  expect(screen.getByLabelText(s.ddlLabel).querySelector(".cm-content")).toHaveAttribute("contenteditable", "false");
  await user.click(screen.getByRole("button", { name: s.copy }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(DDL));
  await screen.findByText(s.copied);
});

test("the DDL follows a forced dark theme while the OS is light", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  document.documentElement.dataset.theme = "dark";
  try {
    const user = userEvent.setup();
    renderTab();
    await user.click(await tab(s.tabs.ddl));
    await waitFor(() => expect(screen.getByLabelText(s.ddlLabel)).toHaveTextContent(DDL));
    expect(vi.mocked(buildEditorTheme)).toHaveBeenLastCalledWith(true);
  } finally {
    delete document.documentElement.dataset.theme;
    vi.unstubAllGlobals();
  }
});

test("Refresh re-fetches with refresh=true and reloads the DDL", async () => {
  renderTab();
  await screen.findByRole("table", { name: s.tabs.columns });
  await userEvent.click(screen.getByRole("button", { name: s.refresh }));
  await waitFor(() => expect(ipc.tableInfo).toHaveBeenLastCalledWith("w1", object, true));
  expect(ipc.tableDdl).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.getByRole("button", { name: s.refresh })).toBeEnabled());
});

test("an info error is shown with its message", async () => {
  vi.mocked(ipc.tableInfo).mockRejectedValue({ kind: "query", message: "relation gone" });
  renderTab();
  expect(await screen.findByRole("alert")).toHaveTextContent(s.loadFailed("relation gone"));
});

test("a DDL error does not hide the structure", async () => {
  vi.mocked(ipc.tableDdl).mockRejectedValue({ kind: "query", message: "no ddl" });
  renderTab();
  await screen.findByRole("table", { name: s.tabs.columns });
  await userEvent.click(screen.getByRole("tab", { name: s.tabs.ddl }));
  expect(await screen.findByRole("alert")).toHaveTextContent(s.ddlFailed("no ddl"));
  await userEvent.click(screen.getByRole("tab", { name: s.tabs.columns }));
  expect(screen.getByRole("table", { name: s.tabs.columns })).toBeInTheDocument();
});

test("a stale response never overwrites a newer load", async () => {
  let resolveOld!: (i: TableInfo) => void;
  const other = { schema: "public", name: "items" };
  const fresh = { ...info, object: other, columns: [col("fresh_col")] };
  vi.mocked(ipc.tableInfo)
    .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
    .mockResolvedValueOnce(fresh);
  const { rerender } = renderTab();
  rerender(<StructureTab workspaceId="w1" object={other} dialect="postgres" />);
  await screen.findByText("fresh_col");
  resolveOld({ ...info, columns: [col("stale_col")] });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByText("stale_col")).toBeNull();
  expect(screen.getByText("fresh_col")).toBeInTheDocument();
});

test("a rejected clipboard write shows the copy failure", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  renderTab();
  await user.click(await tab(s.tabs.ddl));
  await waitFor(() => expect(screen.getByLabelText(s.ddlLabel)).toHaveTextContent(DDL));
  await user.click(screen.getByRole("button", { name: s.copy }));
  expect(await screen.findByText(s.copyFailed)).toBeInTheDocument();
});
