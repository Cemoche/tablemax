import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_WIDTH_KEY, loadSidebarWidth, useSidebar } from "../../stores/sidebar";
import { useSavedQueries } from "../../stores/savedQueries";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { Sidebar, useSidebarShortcuts } from "./Sidebar";

vi.mock("../../lib/ipc");

const S = strings.sidebar;

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  connectionId: `c-${id}`,
  name: id,
  color: "swatch-1",
  envTag: "dev",
  dialect: "postgres",
  status: "connected",
  database: "app",
  schemas: ["public", "audit"],
  currentSchema: "public",
  tabs: [],
  activeTabId: null,
  mru: [],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useSidebar.setState({
    segments: {},
    width: SIDEBAR_DEFAULT,
    match: "contains",
    showTables: true,
    showViews: true,
    focusSearch: false,
  });
  useSavedQueries.setState({ lists: {} });
  useWorkspaces.setState({ workspaces: [ws("w1"), ws("w2")], activeWorkspaceId: "w1", sidebarVisible: true });
  vi.mocked(ipc.objectsList).mockResolvedValue([{ schema: "public", name: "orders", kind: "table" }]);
  vi.mocked(ipc.routinesList).mockResolvedValue([]);
  vi.mocked(ipc.savedQueriesList).mockResolvedValue([]);
  vi.mocked(ipc.historyList).mockResolvedValue([]);
  vi.mocked(ipc.catalogGet).mockResolvedValue({ schema: "public", tables: [] });
});

/** What WorkspaceView does: the shortcuts always, the sidebar when it is shown. */
function Harness({ id }: { id: string }) {
  const workspace = useWorkspaces((s) => s.workspaces.find((w) => w.id === id))!;
  useSidebarShortcuts(id, workspace.status === "connected");
  const visible = useWorkspaces((s) => s.sidebarVisible);
  return visible ? <Sidebar workspace={workspace} /> : null;
}

const segment = (name: string) => screen.getByRole("button", { name });

test("segmented_tabs_switch_and_persist: Items / Queries / History, remembered per workspace", async () => {
  const { rerender } = render(<Harness key="w1" id="w1" />);
  expect(segment(S.segments.items)).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByRole("treeitem", { name: /orders/ })).toBeInTheDocument();

  await userEvent.click(segment(S.segments.queries));
  expect(segment(S.segments.queries)).toHaveAttribute("aria-pressed", "true");
  expect(segment(S.segments.items)).toHaveAttribute("aria-pressed", "false");
  expect(await screen.findByRole("region", { name: strings.savedQueries.label })).toBeInTheDocument();
  expect(screen.queryByRole("treeitem", { name: /orders/ })).toBeNull();

  // Another workspace starts on Items…
  rerender(<Harness key="w2" id="w2" />);
  expect(segment(S.segments.items)).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(segment(S.segments.history));
  expect(await screen.findByRole("region", { name: strings.history.label })).toBeInTheDocument();
  // …and the first one comes back on Queries.
  rerender(<Harness key="w1b" id="w1" />);
  expect(segment(S.segments.queries)).toHaveAttribute("aria-pressed", "true");
});

test("history_shortcut_opens_history_tab: Ctrl+Shift+H shows the sidebar on History", async () => {
  useWorkspaces.setState({ sidebarVisible: false });
  render(<Harness id="w1" />);
  expect(screen.queryByRole("complementary", { name: S.label })).toBeNull();
  fireEvent.keyDown(window, { code: "KeyH", ctrlKey: true, shiftKey: true });
  expect(await screen.findByRole("complementary", { name: S.label })).toBeInTheDocument();
  expect(segment(S.segments.history)).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByRole("region", { name: strings.history.label })).toBeInTheDocument();
  await waitFor(() => expect(ipc.historyList).toHaveBeenCalledWith("c-w1", null, 200));
  // Pressed again it stays on History (it opens, it does not hide).
  fireEvent.keyDown(window, { code: "KeyH", ctrlKey: true, shiftKey: true });
  expect(segment(S.segments.history)).toHaveAttribute("aria-pressed", "true");
});

test("Ctrl+Shift+F shows the sidebar and focuses the search box of the shown tab", async () => {
  useWorkspaces.setState({ sidebarVisible: false });
  render(<Harness id="w1" />);
  fireEvent.keyDown(window, { code: "KeyF", ctrlKey: true, shiftKey: true });
  const search = await screen.findByRole("searchbox", { name: S.searchLabel });
  await waitFor(() => expect(search).toHaveFocus());
  // On Queries, its own search box.
  await userEvent.click(segment(S.segments.queries));
  fireEvent.keyDown(window, { code: "KeyF", ctrlKey: true, shiftKey: true });
  const queries = await screen.findByRole("searchbox", { name: strings.savedQueries.search });
  await waitFor(() => expect(queries).toHaveFocus());
});

test("sidebar_toggle_and_resize: Ctrl+0 hides and shows; the width is dragged, clamped and remembered", async () => {
  render(<Harness id="w1" />);
  const aside = screen.getByRole("complementary", { name: S.label });
  expect(aside.style.width).toBe(`${SIDEBAR_DEFAULT}px`);

  fireEvent.keyDown(window, { code: "Digit0", ctrlKey: true });
  expect(screen.queryByRole("complementary", { name: S.label })).toBeNull();
  fireEvent.keyDown(window, { code: "Digit0", ctrlKey: true });
  expect(screen.getByRole("complementary", { name: S.label })).toBeInTheDocument();

  const handle = screen.getByRole("separator", { name: S.resize });
  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  expect(handle).toHaveAttribute("aria-valuenow", String(SIDEBAR_DEFAULT));
  expect(handle).toHaveAttribute("aria-valuemin", String(SIDEBAR_MIN));
  // Drag 100 px to the right.
  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1, button: 0 });
  fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 400, pointerId: 1 });
  const wider = SIDEBAR_DEFAULT + 100;
  expect(screen.getByRole("complementary", { name: S.label }).style.width).toBe(`${wider}px`);
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(wider));
  // Never narrower than the minimum, with the mouse or the keyboard.
  fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1, button: 0 });
  fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 });
  expect(handle).toHaveAttribute("aria-valuenow", String(SIDEBAR_MIN));
  handle.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(handle).toHaveAttribute("aria-valuenow", String(SIDEBAR_MIN));
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  expect(handle).toHaveAttribute("aria-valuenow", String(SIDEBAR_MIN + 20));
  // The next start reads it back; garbage falls back to the default.
  expect(loadSidebarWidth()).toBe(SIDEBAR_MIN + 20);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "nope");
  expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "12");
  expect(loadSidebarWidth()).toBe(SIDEBAR_MIN);
});

test("the footer: [+] [⌄] [schema] only, the settings live in the connections column (#104)", async () => {
  render(<Harness id="w1" />);
  await screen.findByRole("treeitem", { name: /orders/ });

  expect(screen.queryByRole("button", { name: strings.settings.open })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: S.newQuery }));
  expect(useWorkspaces.getState().workspaces[0].tabs).toEqual([
    expect.objectContaining({ kind: "query", sql: "" }),
  ]);

  await userEvent.click(screen.getByRole("button", { name: S.more }));
  await userEvent.click(screen.getByRole("menuitem", { name: S.refresh }));
  await waitFor(() => expect(ipc.objectsList).toHaveBeenCalledTimes(2));
  expect(ipc.catalogGet).toHaveBeenCalledWith("w1", "public", true);

  const schema = screen.getByRole("combobox", { name: S.schema });
  expect(schema).toHaveValue("public");
  await userEvent.selectOptions(schema, "audit");
  expect(useWorkspaces.getState().workspaces[0].currentSchema).toBe("audit");
});

test("no New SQL query button for a connection without SQL", async () => {
  useWorkspaces.setState({
    workspaces: [
      ws("w1", {
        dialect: null,
        capabilities: {
          sqlEditor: false,
          gridEditing: false,
          routines: false,
          ddl: false,
          foreignKeys: false,
          documents: true,
          databaseSwitch: false,
        },
      }),
    ],
  });
  render(<Harness id="w1" />);
  await screen.findByRole("treeitem", { name: /orders/ });
  expect(screen.queryByRole("button", { name: S.newQuery })).toBeNull();
});

test("the sidebar shortcuts do nothing in a disconnected workspace", () => {
  useWorkspaces.setState({ workspaces: [ws("w1", { status: "disconnected" })], sidebarVisible: false });
  render(<Harness id="w1" />);
  fireEvent.keyDown(window, { code: "KeyF", ctrlKey: true, shiftKey: true });
  expect(useSidebar.getState().focusSearch).toBe(false);
  fireEvent.keyDown(window, { code: "KeyH", ctrlKey: true, shiftKey: true });
  expect(useSidebar.getState().segments.w1).toBeUndefined();
  fireEvent.keyDown(window, { code: "Digit0", ctrlKey: true });
  expect(useWorkspaces.getState().sidebarVisible).toBe(false);
});

test("a resize drag saves the width once, when it ends", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  onTestFinished(() => setItem.mockRestore());
  render(<Harness id="w1" />);
  await screen.findByRole("treeitem", { name: /orders/ });
  const widthWrites = () => setItem.mock.calls.filter(([k]) => k === SIDEBAR_WIDTH_KEY).length;
  const handle = screen.getByRole("separator", { name: S.resize });
  fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1, button: 0 });
  for (const x of [310, 330, 350, 380]) fireEvent.pointerMove(window, { clientX: x, pointerId: 1 });
  expect(handle).toHaveAttribute("aria-valuenow", String(SIDEBAR_DEFAULT + 80));
  expect(widthWrites()).toBe(0);
  fireEvent.pointerUp(window, { clientX: 380, pointerId: 1 });
  expect(widthWrites()).toBe(1);
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_DEFAULT + 80));
});
