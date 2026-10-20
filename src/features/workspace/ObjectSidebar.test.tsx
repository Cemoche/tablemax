import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { Capabilities } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { useSettings } from "../../stores/settings";
import { useSidebar } from "../../stores/sidebar";
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
  useSidebar.setState({ match: "contains", showTables: true, showViews: true, focusSearch: false });
  useChrome.setState({ tableViews: {} });
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
  vi.mocked(ipc.routinesList).mockResolvedValue([
    { schema: "public", name: "do_thing", kind: "function" },
    { schema: "public", name: "purge", kind: "procedure" },
  ]);
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
const M = strings.sidebar.menu;

test("object_context_menu_actions: the items, in order, and what each does", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.mocked(ipc.tableDdl).mockResolvedValue("CREATE TABLE orders (id int);");
  render(<ObjectSidebar workspace={workspace} />);
  const menu = await openMenu(/orders/);
  expect(within(menu).getAllByRole("menuitem").map((i) => i.getAttribute("aria-label") ?? i.textContent)).toEqual([
    M.openNewTab,
    M.openStructure,
    M.copyName,
    M.copyCreate,
    M.copySelectTop,
    M.refresh,
  ]);
  // The two scripts sit under a "Copy script as" heading.
  expect(within(menu).getByText(M.copyScriptAs)).toBeInTheDocument();

  await userEvent.click(within(menu).getByRole("menuitem", { name: M.openNewTab }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({ kind: "table", title: "orders", preview: false });

  await userEvent.click(within(await openMenu(/Accounts/)).getByRole("menuitem", { name: M.openStructure }));
  const accounts = useWorkspaces.getState().workspaces[0].tabs.find((t) => t.title === "Accounts")!;
  expect(accounts).toMatchObject({ kind: "table", preview: false });
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe(accounts.id);
  expect(useChrome.getState().tableViews[accounts.id]).toBe("structure");

  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: M.copyName }));
  expect(writeText).toHaveBeenLastCalledWith("orders");

  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: M.copyCreate }));
  expect(ipc.tableDdl).toHaveBeenCalledWith("w1", { schema: "public", name: "orders" });
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("CREATE TABLE orders (id int);"));

  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: M.copySelectTop }));
  expect(writeText).toHaveBeenLastCalledWith('SELECT * FROM "public"."orders" LIMIT 100;');

  expect(ipc.objectsList).toHaveBeenCalledTimes(1);
  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: M.refresh }));
  await waitFor(() => expect(ipc.objectsList).toHaveBeenCalledTimes(2));
  expect(ipc.catalogGet).toHaveBeenCalledWith("w1", "public", true);
});

test("a failed CREATE script is reported in the sidebar", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn() }, configurable: true });
  vi.mocked(ipc.tableDdl).mockRejectedValue({ kind: "query", message: "no rights" });
  render(<ObjectSidebar workspace={workspace} />);
  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: M.copyCreate }));
  expect(await screen.findByText(strings.sidebar.copyFailed("no rights"))).toBeInTheDocument();
});

test("the menu: Escape closes it, arrows move through the items", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const menu = await openMenu(/orders/);
  const items = within(menu).getAllByRole("menuitem");
  expect(items[0]).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(items[1]).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  expect(items[items.length - 1]).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("routine menu offers Copy name and Refresh", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<ObjectSidebar workspace={workspace} />);
  const menu = await openMenu(/do_thing/);
  expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([M.copyName, M.refresh]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: M.copyName }));
  expect(writeText).toHaveBeenCalledWith("do_thing");
});

test.each([
  ["postgres", "public", 'we"ird', 'SELECT * FROM "public"."we""ird" LIMIT 100;'],
  ["mySql", "shop", "we`ird", "SELECT * FROM `shop`.`we``ird` LIMIT 100;"],
  ["sqlite", "main", 'we"ird', 'SELECT * FROM "we""ird" LIMIT 100;'],
] as const)("SELECT top 100 for %s quotes the name", async (dialect, schema, name, sql) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.mocked(ipc.objectsList).mockResolvedValue([{ schema, name, kind: "table" }]);
  const ws = { ...workspace, dialect, currentSchema: schema };
  useWorkspaces.setState({ workspaces: [ws] });
  render(<ObjectSidebar workspace={ws} />);
  await userEvent.click(
    within(await openMenu(new RegExp(name.replace(/[`"]/g, ".")))).getByRole("menuitem", { name: M.copySelectTop }),
  );
  expect(writeText).toHaveBeenCalledWith(sql);
});

test("Refresh reloads objects and routines and forces the catalog", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: M.refresh }));
  await waitFor(() => expect(ipc.objectsList).toHaveBeenCalledTimes(2));
  expect(ipc.routinesList).toHaveBeenCalledTimes(2);
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
  // Ctrl+K (the palette) switches the database now; the sidebar follows the workspace.
  await act(() => useWorkspaces.getState().switchDatabase("w1", "other"));
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

test("without the capabilities: no routines, no CREATE and no SELECT script", async () => {
  render(<ObjectSidebar workspace={{ ...workspace, dialect: null, capabilities: NO_SQL }} />);
  await screen.findByRole("button", { name: /orders/ });
  expect(screen.queryByRole("button", { name: strings.sidebar.routines })).toBeNull();
  expect(ipc.routinesList).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByRole("button", { name: /orders/ }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: M.copySelectTop })).toBeNull();
  expect(within(menu).queryByRole("menuitem", { name: M.copyCreate })).toBeNull();
  expect(within(menu).queryByText(M.copyScriptAs)).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: M.openNewTab })).toBeTruthy();
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

const S = strings.sidebar;
const names = () =>
  screen
    .queryAllByRole("button")
    .filter((b) => b.dataset.objectRow !== undefined)
    .map((b) => b.dataset.objectRow);

test("search_options_filter_tree: contains / starts with / ends with, tables and views", async () => {
  render(<ObjectSidebar workspace={{ ...workspace, capabilities: { ...NO_SQL, sqlEditor: true } }} />);
  await screen.findByRole("button", { name: /Accounts/ });
  const search = screen.getByRole("searchbox", { name: S.searchLabel });
  expect(search).toHaveAttribute("placeholder", S.search);
  await userEvent.type(search, "users");
  expect(names()).toEqual(["users", "active_users"]);

  const options = screen.getByRole("button", { name: S.searchOptions });
  await userEvent.click(options);
  await userEvent.click(screen.getByRole("menuitemradio", { name: S.match.startsWith }));
  expect(useSidebar.getState().match).toBe("startsWith");
  expect(names()).toEqual(["users"]);

  await userEvent.click(options);
  expect(screen.getByRole("menuitemradio", { name: S.match.startsWith })).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: S.match.endsWith }));
  await userEvent.clear(search);
  await userEvent.type(search, "RS");
  expect(names()).toEqual(["users", "orders", "active_users"]);

  // Tables off: only the views are left.
  await userEvent.click(options);
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: S.showTables }));
  expect(names()).toEqual(["active_users"]);
  await userEvent.click(options);
  expect(screen.getByRole("menuitemcheckbox", { name: S.showTables })).toHaveAttribute("aria-checked", "false");
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: S.showViews }));
  expect(names()).toEqual([]);
  expect(screen.getByText(S.noMatch)).toBeInTheDocument();
});

test("tree_icons_by_kind: each row has the icon of its kind", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const orders = await screen.findByRole("button", { name: /orders/ });
  expect(within(orders).getByRole("img", { name: S.kinds.table })).toBeInTheDocument();
  const view = screen.getByRole("button", { name: /active_users/ });
  expect(within(view).getByRole("img", { name: S.kinds.view })).toBeInTheDocument();
  const fn = await screen.findByRole("button", { name: /do_thing/ });
  expect(within(fn).getByRole("img", { name: S.kinds.function })).toBeInTheDocument();
  const proc = screen.getByRole("button", { name: /purge/ });
  expect(within(proc).getByRole("img", { name: S.kinds.procedure })).toBeInTheDocument();
});

test("long_names_truncate: one line with an ellipsis, the full name in the tooltip", async () => {
  const long = "a_really_long_table_name_that_does_not_fit_in_the_sidebar_at_all";
  vi.mocked(ipc.objectsList).mockResolvedValue([{ schema: "public", name: long, kind: "table" }]);
  render(<ObjectSidebar workspace={workspace} />);
  const row = await screen.findByRole("button", { name: new RegExp(long) });
  expect(row).toHaveAttribute("title", long);
  expect(row).toHaveClass("whitespace-nowrap");
  expect(within(row).getByText(long)).toHaveClass("truncate");
});

test("the tree is monospace at the data font size, with 24 px rows", async () => {
  useSettings.setState((s) => ({ settings: { ...s.settings, dataFontSize: 15 } }));
  render(<ObjectSidebar workspace={workspace} />);
  const row = await screen.findByRole("button", { name: /orders/ });
  const tree = row.closest("[data-tree]") as HTMLElement;
  expect(tree).toHaveClass("font-mono");
  expect(tree.style.fontSize).toBe("15px");
  expect(row.style.height).toBe("24px");
  useSettings.setState((s) => ({ settings: { ...s.settings, dataFontSize: 13 } }));
});

test("thousands of objects: only the rows in view are rendered, scrolling shows the others", async () => {
  vi.mocked(ipc.objectsList).mockResolvedValue(
    Array.from({ length: 5000 }, (_, i) => ({ schema: "public", name: `t${String(i).padStart(4, "0")}`, kind: "table" as const })),
  );
  vi.mocked(ipc.routinesList).mockResolvedValue([]);
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("button", { name: /t0000/ });
  expect(names().length).toBeLessThan(100);
  expect(screen.queryByRole("button", { name: /t4999/ })).toBeNull();
  const scroller = screen.getByRole("button", { name: /t0000/ }).closest("[data-tree]") as HTMLElement;
  scroller.scrollTop = 4990 * 24;
  fireEvent.scroll(scroller);
  expect(await screen.findByRole("button", { name: /t4999/ })).toBeInTheDocument();
  expect(names().length).toBeLessThan(100);
});

test("arrow keys move between the rows", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const accounts = await screen.findByRole("button", { name: /Accounts/ });
  accounts.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getByTitle("users")).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  expect(accounts).toHaveFocus();
});
