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
  await screen.findByRole("treeitem", { name: /Accounts/ });
  expect(ipc.objectsList).toHaveBeenCalledWith("w1", "public");
  await userEvent.type(screen.getByRole("searchbox"), "USER");
  const items = screen.getAllByRole("treeitem", { name: /users/i }).map((b) => b.textContent);
  expect(items[0]).toContain("users");
  expect(items[1]).toContain("active_users");
  expect(screen.queryByRole("treeitem", { name: /orders/ })).toBeNull();
});

test("clicking an object opens a table tab", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await userEvent.click(await screen.findByRole("treeitem", { name: /orders/ }));
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(1));
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({
    kind: "table",
    title: "orders",
  });
});

test("single click opens a preview tab, double click pins it", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const orders = await screen.findByRole("treeitem", { name: /orders/ });
  await userEvent.click(orders);
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({ preview: true });
  await userEvent.dblClick(orders);
  const tabs = useWorkspaces.getState().workspaces[0].tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ preview: false });
});

test("sections collapse and the filter applies to routines", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("treeitem", { name: /do_thing/ });
  const routines = screen.getByRole("treeitem", { name: strings.sidebar.routines, expanded: true });
  await userEvent.type(screen.getByRole("searchbox"), "purge");
  expect(screen.queryByRole("treeitem", { name: /do_thing/ })).toBeNull();
  expect(screen.getByRole("treeitem", { name: /purge/ })).toBeTruthy();
  expect(screen.queryByRole("treeitem", { name: /orders/ })).toBeNull();
  await userEvent.click(routines);
  expect(routines.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("treeitem", { name: /purge/ })).toBeNull();
});

test("views section lists views apart from tables", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("treeitem", { name: /orders/ });
  expect(screen.getByRole("treeitem", { name: strings.sidebar.tables })).toBeTruthy();
  expect(screen.getByRole("treeitem", { name: strings.sidebar.views })).toBeTruthy();
});

const openMenu = async (name: RegExp) => {
  fireEvent.contextMenu(await screen.findByRole("treeitem", { name }));
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

test("the menu: Escape closes it and gives the focus back to its row, arrows move through the items", async () => {
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
  expect(screen.getByRole("treeitem", { name: "orders" })).toHaveFocus();
  // A press outside on nothing focusable closes it too, the focus goes back the same way.
  await openMenu(/Accounts/);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(screen.getByRole("treeitem", { name: "Accounts" })).toHaveFocus());
});

/** Stands for the SQL editor or the grid: they focus themselves on mousedown (preventDefault). */
const SelfFocusing = () => (
  <input
    aria-label="editor stand-in"
    onMouseDown={(e) => {
      e.preventDefault();
      e.currentTarget.focus();
    }}
  />
);

test("a press outside on something that takes the focus leaves the focus there", async () => {
  render(
    <>
      <ObjectSidebar workspace={workspace} />
      <SelfFocusing />
    </>,
  );
  await openMenu(/orders/);
  const editor = screen.getByRole("textbox", { name: "editor stand-in" });
  fireEvent.mouseDown(editor);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(editor).toHaveFocus();
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(editor).toHaveFocus();
});

test("the focus goes back to the same object after the rows moved under the open menu", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await openMenu(/active_users/);
  // The rows shift while the menu is open (Accounts and orders go away).
  fireEvent.change(screen.getByRole("searchbox", { name: S.searchLabel }), { target: { value: "user" } });
  expect(names()).toEqual(["users", "active_users"]);
  await userEvent.keyboard("{Escape}");
  expect(item("active_users")).toHaveFocus();
  expect(item("active_users").tabIndex).toBe(0);
});

test("Shift+F10 opens the menu of the focused row", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const orders = await screen.findByRole("treeitem", { name: "orders" });
  orders.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  expect(await screen.findByRole("menu")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(orders).toHaveFocus();
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
  await screen.findByRole("treeitem", { name: /orders/ });
  vi.mocked(ipc.objectsList).mockResolvedValue([{ schema: "public", name: "fresh", kind: "table" }]);
  // Ctrl+K (the palette) switches the database now; the sidebar follows the workspace.
  await act(() => useWorkspaces.getState().switchDatabase("w1", "other"));
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].database).toBe("other"));
  rerender(view(useWorkspaces.getState().workspaces[0]));
  expect(await screen.findByRole("treeitem", { name: /fresh/ })).toBeTruthy();
  expect(screen.queryByRole("treeitem", { name: /orders/ })).toBeNull();
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
  await screen.findByRole("treeitem", { name: /orders/ });
  expect(screen.queryByRole("treeitem", { name: strings.sidebar.routines })).toBeNull();
  expect(ipc.routinesList).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: /orders/ }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: M.copySelectTop })).toBeNull();
  expect(within(menu).queryByRole("menuitem", { name: M.copyCreate })).toBeNull();
  expect(within(menu).queryByText(M.copyScriptAs)).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: M.openNewTab })).toBeTruthy();
});

test("the toolbar's Reload reloads the objects", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("treeitem", { name: /Accounts/ });
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
    .queryAllByRole("treeitem")
    .filter((b) => b.dataset.objectRow !== undefined)
    .map((b) => b.dataset.objectRow);

test("search_options_filter_tree: contains / starts with / ends with, tables and views", async () => {
  render(<ObjectSidebar workspace={{ ...workspace, capabilities: { ...NO_SQL, sqlEditor: true } }} />);
  await screen.findByRole("treeitem", { name: /Accounts/ });
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
  const orders = await screen.findByRole("treeitem", { name: /orders/ });
  expect(within(orders).getByRole("img", { name: S.kinds.table })).toBeInTheDocument();
  const view = screen.getByRole("treeitem", { name: /active_users/ });
  expect(within(view).getByRole("img", { name: S.kinds.view })).toBeInTheDocument();
  const fn = await screen.findByRole("treeitem", { name: /do_thing/ });
  expect(within(fn).getByRole("img", { name: S.kinds.function })).toBeInTheDocument();
  const proc = screen.getByRole("treeitem", { name: /purge/ });
  expect(within(proc).getByRole("img", { name: S.kinds.procedure })).toBeInTheDocument();
});

test("long_names_truncate: one line with an ellipsis, the full name in the tooltip", async () => {
  const long = "a_really_long_table_name_that_does_not_fit_in_the_sidebar_at_all";
  vi.mocked(ipc.objectsList).mockResolvedValue([{ schema: "public", name: long, kind: "table" }]);
  render(<ObjectSidebar workspace={workspace} />);
  const row = await screen.findByRole("treeitem", { name: new RegExp(long) });
  expect(row).toHaveAttribute("data-tooltip", long);
  // Shown only while the name is cut (review #109).
  expect(row).toHaveAttribute("data-tooltip-overflow");
  expect(row).toHaveClass("whitespace-nowrap");
  expect(within(row).getByText(long)).toHaveClass("truncate");
});

test("the tree is monospace at the data font size, with 24 px rows", async () => {
  useSettings.setState((s) => ({ settings: { ...s.settings, dataFontSize: 15 } }));
  render(<ObjectSidebar workspace={workspace} />);
  const row = await screen.findByRole("treeitem", { name: /orders/ });
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
  await screen.findByRole("treeitem", { name: /t0000/ });
  expect(names().length).toBeLessThan(100);
  expect(screen.queryByRole("treeitem", { name: /t4999/ })).toBeNull();
  const scroller = screen.getByRole("treeitem", { name: /t0000/ }).closest("[data-tree]") as HTMLElement;
  scroller.scrollTop = 4990 * 24;
  fireEvent.scroll(scroller);
  expect(await screen.findByRole("treeitem", { name: /t4999/ })).toBeInTheDocument();
  expect(names().length).toBeLessThan(100);
});

const T = () => screen.getByRole("tree", { name: S.treeLabel });
const item = (name: string) => screen.getByRole("treeitem", { name });

test("the tree has tree semantics: levels, expanded sections, set sizes and positions", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("treeitem", { name: "orders" });
  expect(T()).toBeInTheDocument();
  const tables = item(S.tables);
  expect(tables).toHaveAttribute("aria-level", "1");
  expect(tables).toHaveAttribute("aria-expanded", "true");
  expect(tables).toHaveAttribute("aria-setsize", "3");
  expect(tables).toHaveAttribute("aria-posinset", "1");
  expect(item(S.routines)).toHaveAttribute("aria-posinset", "3");
  const orders = item("orders");
  expect(orders).toHaveAttribute("aria-level", "2");
  expect(orders).not.toHaveAttribute("aria-expanded");
  // Accounts, users, orders: the third of three tables.
  expect(orders).toHaveAttribute("aria-setsize", "3");
  expect(orders).toHaveAttribute("aria-posinset", "3");
  expect(orders).toHaveAttribute("aria-selected", "false");
});

test("the tree is a single Tab stop (roving tabindex)", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("treeitem", { name: "orders" });
  const stops = within(T())
    .getAllByRole("treeitem")
    .filter((r) => r.tabIndex === 0);
  expect(stops).toHaveLength(1);
  screen.getByRole("searchbox").focus();
  await userEvent.tab(); // search options
  await userEvent.tab();
  expect(item(S.tables)).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  expect(item("users")).toHaveFocus();
  expect(item("users").tabIndex).toBe(0);
  expect(item(S.tables).tabIndex).toBe(-1);
  // Tab leaves the tree; Shift+Tab comes back to the row that had the focus.
  await userEvent.tab();
  expect(T()).not.toContainElement(document.activeElement as HTMLElement);
  await userEvent.tab({ shift: true });
  expect(item("users")).toHaveFocus();
});

test("the Tab stop stays rendered once, at its place, when it is scrolled out of view", async () => {
  vi.mocked(ipc.objectsList).mockResolvedValue(
    Array.from({ length: 5000 }, (_, i) => ({ schema: "public", name: `t${String(i).padStart(4, "0")}`, kind: "table" as const })),
  );
  vi.mocked(ipc.routinesList).mockResolvedValue([]);
  render(<ObjectSidebar workspace={workspace} />);
  const first = await screen.findByRole("treeitem", { name: "t0000" });
  first.focus();
  const scroller = T();
  scroller.scrollTop = 5001 * 24;
  fireEvent.scroll(scroller);
  expect(await screen.findByRole("treeitem", { name: "t4999" })).toBeInTheDocument();
  const copies = within(scroller).getAllByRole("treeitem", { name: "t0000" });
  expect(copies).toHaveLength(1);
  expect(copies[0].tabIndex).toBe(0);
  // t0000 is the second row (after the Tables header).
  expect(copies[0].style.top).toBe("24px");
  expect(names().length).toBeLessThan(100);
});

test("arrow keys, Home and End move between the rows", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const accounts = await screen.findByRole("treeitem", { name: "Accounts" });
  accounts.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(item("users")).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  expect(accounts).toHaveFocus();
  await screen.findByRole("treeitem", { name: "purge" });
  await userEvent.keyboard("{End}");
  expect(item("purge")).toHaveFocus();
  await userEvent.keyboard("{Home}");
  expect(item(S.tables)).toHaveFocus();
});

test("Left / Right collapse and expand a section, and move between a row and its section", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const orders = await screen.findByRole("treeitem", { name: "orders" });
  orders.focus();
  // Left on an object: its section.
  await userEvent.keyboard("{ArrowLeft}");
  expect(item(S.tables)).toHaveFocus();
  // Left on an open section: collapse it (the focus stays).
  await userEvent.keyboard("{ArrowLeft}");
  expect(item(S.tables)).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("treeitem", { name: "orders" })).toBeNull();
  expect(item(S.tables)).toHaveFocus();
  // Right on a closed section: expand it; Right again: its first child.
  await userEvent.keyboard("{ArrowRight}");
  expect(item(S.tables)).toHaveAttribute("aria-expanded", "true");
  expect(item(S.tables)).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  expect(item("Accounts")).toHaveFocus();
});

test("Enter opens the focused object in a tab, Enter on a section toggles it", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const orders = await screen.findByRole("treeitem", { name: "orders" });
  orders.focus();
  await userEvent.keyboard("{Enter}");
  expect(useWorkspaces.getState().workspaces[0].tabs).toEqual([
    expect.objectContaining({ kind: "table", title: "orders", preview: false }),
  ]);
  item(S.views).focus();
  await userEvent.keyboard("{Enter}");
  expect(item(S.views)).toHaveAttribute("aria-expanded", "false");
});

test("the selection follows the active tab once another tab is shown", async () => {
  const Live = () => <ObjectSidebar workspace={useWorkspaces((s) => s.workspaces[0])} />;
  render(<Live />);
  await userEvent.click(await screen.findByRole("treeitem", { name: "orders" }));
  expect(item("orders")).toHaveAttribute("aria-selected", "true");
  // A routine click (its menu) selects it; then another tab is shown: the selection follows it.
  await userEvent.click(await screen.findByRole("treeitem", { name: "do_thing" }));
  await userEvent.keyboard("{Escape}");
  expect(item("do_thing")).toHaveAttribute("aria-selected", "true");
  act(() => useWorkspaces.getState().openTableTab("w1", { schema: "public", name: "Accounts" }));
  expect(item("do_thing")).toHaveAttribute("aria-selected", "false");
  expect(item("Accounts")).toHaveAttribute("aria-selected", "true");
  // A SQL tab: nothing is selected.
  act(() => useWorkspaces.getState().openQueryTab("w1"));
  expect(within(T()).queryAllByRole("treeitem", { selected: true })).toEqual([]);
});

test("Copy name without a clipboard reports the failure", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  render(<ObjectSidebar workspace={workspace} />);
  await userEvent.click(within(await openMenu(/orders/)).getByRole("menuitem", { name: M.copyName }));
  expect(await screen.findByRole("alert")).toHaveTextContent(S.copyFailed(S.clipboardUnavailable));
});
