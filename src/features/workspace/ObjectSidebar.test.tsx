import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { Capabilities } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { ObjectSidebar } from "./ObjectSidebar";

vi.mock("../../lib/ipc");

const workspace: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  database: null,
  schemas: ["public", "audit"],
  currentSchema: "public",
  tabs: [],
  activeTabId: null,
  mru: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
  vi.mocked(ipc.routinesList).mockResolvedValue([
    { schema: "public", name: "do_thing", kind: "function" },
    { schema: "public", name: "purge", kind: "procedure" },
  ]);
  vi.mocked(ipc.databasesList).mockResolvedValue(["app", "other"]);
  vi.mocked(ipc.catalogGet).mockResolvedValue({ schema: "public", objects: [] } as never);
  vi.mocked(ipc.schemasList).mockResolvedValue(["public"]);
  vi.mocked(ipc.objectsList).mockResolvedValue([
    { schema: "public", name: "Accounts", kind: "table" },
    { schema: "public", name: "users", kind: "table" },
    { schema: "public", name: "active_users", kind: "view" },
    { schema: "public", name: "orders", kind: "table" },
  ]);
});

test("sidebar filter is case-insensitive and keeps tables before views", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("button", { name: /Accounts/ });
  expect(ipc.objectsList).toHaveBeenCalledWith("w1", "public");
  await userEvent.type(screen.getByRole("searchbox"), "USER");
  const items = screen.getAllByRole("button", { name: /users/i }).map((b) => b.textContent);
  expect(items[0]).toContain("users");
  expect(items[1]).toContain("active_users");
  expect(screen.queryByRole("button", { name: /orders/ })).toBeNull();
});

test("clicking an object opens a table tab", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await userEvent.click(await screen.findByRole("button", { name: /orders/ }));
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(1));
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({
    kind: "table",
    title: "orders",
  });
});

test("single click opens a preview tab, double click pins it", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const orders = await screen.findByRole("button", { name: /orders/ });
  await userEvent.click(orders);
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({ preview: true });
  await userEvent.dblClick(orders);
  const tabs = useWorkspaces.getState().workspaces[0].tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ preview: false });
});

test("database selector is PG-only and switches database", async () => {
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue({
    workspaceId: "w1",
    dialect: "postgres",
    database: "other",
  } as never);
  render(<ObjectSidebar workspace={workspace} />);
  const sel = await screen.findByRole("combobox", { name: strings.sidebar.database });
  await waitFor(() => expect(within(sel).getAllByRole("option")).toHaveLength(2));
  await userEvent.selectOptions(sel, "other");
  expect(ipc.workspaceSwitchDatabase).toHaveBeenCalledWith("w1", "other");
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].database).toBe("other"));
});

test("database switch failure shows a message and keeps the old database", async () => {
  vi.mocked(ipc.workspaceSwitchDatabase).mockRejectedValue({ kind: "invalid", message: "nope" });
  useWorkspaces.setState({ workspaces: [{ ...workspace, database: "app" }] });
  render(<ObjectSidebar workspace={{ ...workspace, database: "app" }} />);
  const sel = await screen.findByRole("combobox", { name: strings.sidebar.database });
  await waitFor(() => expect(within(sel).getAllByRole("option")).toHaveLength(2));
  await userEvent.selectOptions(sel, "other");
  expect(await screen.findByText(new RegExp(`${strings.sidebar.switchFailed}.*nope`))).toBeTruthy();
  expect(useWorkspaces.getState().workspaces[0].database).toBe("app");
});

test.each(["mySql", "sqlite"] as const)("no database selector for %s", async (dialect) => {
  render(<ObjectSidebar workspace={{ ...workspace, dialect }} />);
  await screen.findByRole("button", { name: /orders/ });
  expect(screen.queryByRole("combobox", { name: strings.sidebar.database })).toBeNull();
  expect(ipc.databasesList).not.toHaveBeenCalled();
});

test("sections collapse and the filter applies to routines", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("button", { name: /do_thing/ });
  const routines = screen.getByRole("button", { name: strings.sidebar.routines, expanded: true });
  await userEvent.type(screen.getByRole("searchbox"), "purge");
  expect(screen.queryByRole("button", { name: /do_thing/ })).toBeNull();
  expect(screen.getByRole("button", { name: /purge/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /orders/ })).toBeNull();
  await userEvent.click(routines);
  expect(routines.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: /purge/ })).toBeNull();
});

test("views section lists views apart from tables", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("button", { name: /orders/ });
  expect(screen.getByRole("button", { name: strings.sidebar.tables })).toBeTruthy();
  expect(screen.getByRole("button", { name: strings.sidebar.views })).toBeTruthy();
});

const openMenu = async (name: RegExp) => {
  fireEvent.contextMenu(await screen.findByRole("button", { name }));
  return screen.findByRole("menu");
};

test("context menu: Open and Open in new tab", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: strings.sidebar.menu.open }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({ preview: true });
  await userEvent.click(
    within(await openMenu(/orders/)).getByRole("menuitem", { name: strings.sidebar.menu.openNewTab }),
  );
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({ preview: false });
});

test("context menu: Escape closes, Copy name copies the bare name", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<ObjectSidebar workspace={workspace} />);
  await openMenu(/orders/);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: strings.sidebar.menu.copyName }));
  expect(writeText).toHaveBeenCalledWith("orders");
  await userEvent.click(within(await openMenu(/do_thing/)).getByRole("menuitem", { name: strings.sidebar.menu.copyName }));
  expect(writeText).toHaveBeenLastCalledWith("do_thing");
});

test("routine menu only offers Copy name", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const menu = await openMenu(/do_thing/);
  expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
});

test.each([
  ["postgres", "public", 'we"ird', 'SELECT * FROM "public"."we""ird" LIMIT 100;'],
  ["mySql", "shop", "we`ird", "SELECT * FROM `shop`.`we``ird` LIMIT 100;"],
  ["sqlite", "main", 'we"ird', 'SELECT * FROM "we""ird" LIMIT 100;'],
] as const)("New query for %s quotes the name", async (dialect, schema, name, sql) => {
  vi.mocked(ipc.objectsList).mockResolvedValue([{ schema, name, kind: "table" }]);
  const ws = { ...workspace, dialect, currentSchema: schema };
  useWorkspaces.setState({ workspaces: [ws] });
  render(<ObjectSidebar workspace={ws} />);
  await userEvent.click(
    within(await openMenu(new RegExp(name.replace(/[`"]/g, ".")))).getByRole("menuitem", {
      name: strings.sidebar.menu.newQuery,
    }),
  );
  const tab = useWorkspaces.getState().workspaces[0].tabs[0];
  expect(tab).toMatchObject({ kind: "query", sql });
});

test("Refresh reloads objects, routines, databases and forces the catalog", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("button", { name: /orders/ });
  await userEvent.click(screen.getByRole("button", { name: strings.sidebar.refresh }));
  await waitFor(() => expect(ipc.objectsList).toHaveBeenCalledTimes(2));
  expect(ipc.routinesList).toHaveBeenCalledTimes(2);
  expect(ipc.databasesList).toHaveBeenCalledTimes(2);
  expect(ipc.catalogGet).toHaveBeenCalledWith("w1", "public", true);
});

test("switching database reloads objects and routines even when the schema stays", async () => {
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue({
    workspaceId: "w1",
    dialect: "postgres",
    database: "other",
  } as never);
  useWorkspaces.setState({ workspaces: [{ ...workspace, database: "app" }] });
  const view = (ws: Workspace) => <ObjectSidebar workspace={ws} />;
  const { rerender } = render(view({ ...workspace, database: "app" }));
  await screen.findByRole("button", { name: /orders/ });
  vi.mocked(ipc.objectsList).mockResolvedValue([{ schema: "public", name: "fresh", kind: "table" }]);
  const sel = await screen.findByRole("combobox", { name: strings.sidebar.database });
  await waitFor(() => expect(within(sel).getAllByRole("option")).toHaveLength(2));
  await userEvent.selectOptions(sel, "other");
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].database).toBe("other"));
  rerender(view(useWorkspaces.getState().workspaces[0]));
  expect(await screen.findByRole("button", { name: /fresh/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /orders/ })).toBeNull();
});

/** A connection without SQL (e.g. a document database). */
const NO_SQL: Capabilities = {
  sqlEditor: false,
  gridEditing: false,
  routines: false,
  ddl: false,
  foreignKeys: false,
  documents: true,
  databaseSwitch: false,
};

test("without the capabilities: no routines, no database selector, no New query item", async () => {
  render(<ObjectSidebar workspace={{ ...workspace, dialect: null, capabilities: NO_SQL }} />);
  await screen.findByRole("button", { name: /orders/ });
  expect(screen.queryByRole("button", { name: strings.sidebar.routines })).toBeNull();
  expect(ipc.routinesList).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox", { name: strings.sidebar.database })).toBeNull();
  expect(ipc.databasesList).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByRole("button", { name: /orders/ }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: strings.sidebar.menu.newQuery })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: strings.sidebar.menu.open })).toBeTruthy();
});

test("the toolbar's Reload reloads the objects", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("button", { name: /Accounts/ });
  expect(ipc.objectsList).toHaveBeenCalledTimes(1);
  act(() => useChrome.getState().requestReload("w1"));
  await waitFor(() => expect(ipc.objectsList).toHaveBeenCalledTimes(2));
  // Another workspace's reload is not ours.
  act(() => useChrome.getState().requestReload("w2"));
  expect(ipc.objectsList).toHaveBeenCalledTimes(2);
});
