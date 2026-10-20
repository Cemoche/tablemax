import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { SavedQuery } from "../../lib/types";
import { useCatalog } from "../../stores/catalog";
import { useChrome } from "../../stores/chrome";
import { useSavedQueries } from "../../stores/savedQueries";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { QueryTab } from "./QueryTab";
import { SavedQueries } from "./SavedQueries";

vi.mock("../../lib/ipc");
vi.mock("./SqlEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SqlEditor")>();
  return {
    ...actual,
    SqlEditor: (p: Parameters<typeof actual.SqlEditor>[0]) => (
      <textarea aria-label="SQL editor" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
    ),
  };
});

const S = strings.savedQueries;
const sq = (name: string): SavedQuery => ({ name, modifiedAt: 0, size: 1 });

type QueryTabT = Extract<Tab, { kind: "query" }>;

const setup = async (tab: Partial<QueryTabT> = {}, saved: SavedQuery[] = []) => {
  const t: QueryTabT = { id: "t1", kind: "query", title: "Query 1", sql: "select 1", sqlSessionId: null, ...tab };
  useWorkspaces.setState({
    workspaces: [
      {
        id: "w1",
        connectionId: "c1",
        name: "Local",
        color: "swatch-1",
        envTag: "dev",
        dialect: "postgres",
        status: "connected",
        database: null,
        schemas: ["public"],
        currentSchema: "public",
        tabs: [t],
        activeTabId: "t1",
        mru: ["t1"],
      } satisfies Workspace,
    ],
    activeWorkspaceId: "w1",
  });
  vi.mocked(ipc.savedQueriesList).mockResolvedValue(saved);
  const Live = () => {
    const ws = useWorkspaces((s) => s.workspaces[0]);
    const active = ws.tabs.find((x) => x.id === ws.activeTabId);
    return active?.kind === "query" ? <QueryTab key={active.id} workspace={ws} tab={active} /> : null;
  };
  const r = render(<Live />);
  await act(async () => {});
  return r;
};

const tab0 = () => useWorkspaces.getState().workspaces[0].tabs[0] as QueryTabT;
const pressModS = () => fireEvent.keyDown(window, { code: "KeyS", key: "s", ctrlKey: true });

beforeEach(() => {
  vi.resetAllMocks();
  useCatalog.setState({ catalogs: {}, errors: {}, loading: {} });
  useSavedQueries.setState({ lists: {} });
  useChrome.setState({ runRequests: {}, editorInserts: {} });
  vi.mocked(ipc.catalogGet).mockResolvedValue({ schema: "public", tables: [] });
  vi.mocked(ipc.savedQueryWrite).mockResolvedValue(undefined);
  vi.mocked(ipc.savedQueryRename).mockResolvedValue(undefined);
  vi.mocked(ipc.savedQueryDelete).mockResolvedValue(undefined);
  vi.mocked(ipc.historyList).mockResolvedValue([]);
});

/** The sidebar's Queries tab next to the active SQL tab (as WorkspaceView shows them). */
const setupPanel = async (tab: Partial<QueryTabT> = {}, saved: SavedQuery[] = []) => {
  const r = await setup(tab, saved);
  const ws = () => useWorkspaces.getState().workspaces[0];
  r.rerender(<></>);
  const Both = () => {
    const w = useWorkspaces((s) => s.workspaces[0]);
    const active = w.tabs.find((x) => x.id === w.activeTabId);
    return (
      <>
        <SavedQueries workspace={w} />
        {active?.kind === "query" && <QueryTab key={active.id} workspace={w} tab={active} />}
      </>
    );
  };
  r.rerender(<Both />);
  await act(async () => {});
  return { ...r, ws };
};

const openMenu = async (name: string) => {
  fireEvent.contextMenu(await screen.findByRole("button", { name: S.open(name) }));
  return screen.findByRole("menu", { name: S.menuLabel });
};
const Q = strings.sqlMenu;

test("the panel lists the connection's saved queries", async () => {
  await setupPanel({}, [sq("daily report"), sq("users")]);
  expect(ipc.savedQueriesList).toHaveBeenCalledWith("c1");
  const panel = screen.getByRole("region", { name: S.label });
  expect(within(panel).getByRole("button", { name: S.open("daily report") })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: S.open("users") })).toBeInTheDocument();
});

test("Mod+S on an unlinked tab asks for a name, then saves and renames the tab", async () => {
  await setupPanel({ sql: "select 42" });
  pressModS();
  const dialog = screen.getByRole("dialog", { name: S.saveTitle });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  await userEvent.type(within(dialog).getByRole("textbox", { name: S.nameLabel }), "answer");
  vi.mocked(ipc.savedQueriesList).mockResolvedValue([sq("answer")]);
  await userEvent.click(within(dialog).getByRole("button", { name: S.saveConfirm }));
  await waitFor(() => expect(ipc.savedQueryWrite).toHaveBeenCalledWith("c1", "answer", "select 42"));
  await waitFor(() => expect(tab0()).toMatchObject({ title: "answer", savedName: "answer", savedSql: "select 42" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  // The list follows.
  expect(await screen.findByRole("button", { name: S.open("answer") })).toBeInTheDocument();
});

test("the backend's name error stays in the dialog", async () => {
  await setup();
  pressModS();
  vi.mocked(ipc.savedQueryWrite).mockRejectedValue({ kind: "invalid", message: "invalid query name" });
  const dialog = screen.getByRole("dialog", { name: S.saveTitle });
  await userEvent.type(within(dialog).getByRole("textbox", { name: S.nameLabel }), "../x");
  await userEvent.click(within(dialog).getByRole("button", { name: S.saveConfirm }));
  expect(await within(dialog).findByText("invalid query name")).toBeInTheDocument();
  expect(tab0().savedName ?? null).toBeNull();
  expect(tab0().title).toBe("Query 1");
});

test("saving onto an existing name asks before replacing it", async () => {
  await setup({ sql: "select 2" }, [sq("taken")]);
  pressModS();
  const dialog = screen.getByRole("dialog", { name: S.saveTitle });
  await userEvent.type(within(dialog).getByRole("textbox", { name: S.nameLabel }), "taken");
  await userEvent.click(within(dialog).getByRole("button", { name: S.saveConfirm }));
  const confirm = await screen.findByRole("alertdialog", { name: S.replaceTitle });
  expect(ipc.savedQueryWrite).not.toHaveBeenCalled();
  await userEvent.click(within(confirm).getByRole("button", { name: S.replaceConfirm }));
  await waitFor(() => expect(ipc.savedQueryWrite).toHaveBeenCalledWith("c1", "taken", "select 2"));
});

test("saving onto a case variant of an existing name replaces that query, under its spelling", async () => {
  // On a case-sensitive file system `report` would be a second file next to `Report`.
  await setup({ sql: "select 2" }, [sq("Report")]);
  pressModS();
  const dialog = screen.getByRole("dialog", { name: S.saveTitle });
  await userEvent.type(within(dialog).getByRole("textbox", { name: S.nameLabel }), "report");
  await userEvent.click(within(dialog).getByRole("button", { name: S.saveConfirm }));
  const confirm = await screen.findByRole("alertdialog", { name: S.replaceTitle });
  expect(confirm).toHaveTextContent(S.replaceBody("Report"));
  await userEvent.click(within(confirm).getByRole("button", { name: S.replaceConfirm }));
  await waitFor(() => expect(ipc.savedQueryWrite).toHaveBeenCalledWith("c1", "Report", "select 2"));
  expect(ipc.savedQueryWrite).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(tab0()).toMatchObject({ title: "Report", savedName: "Report" }));
});

test("Mod+S on a linked tab overwrites silently", async () => {
  await setup({ title: "report", sql: "select 3", savedName: "report", savedSql: "select 1" }, [sq("report")]);
  pressModS();
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(ipc.savedQueryWrite).toHaveBeenCalledWith("c1", "report", "select 3"));
  await waitFor(() => expect(tab0().savedSql).toBe("select 3"));
});

test("Mod+S does nothing while a modal is open", async () => {
  await setup({ title: "report", savedName: "report", savedSql: "select 1" });
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.appendChild(modal);
  pressModS();
  modal.remove();
  await act(async () => {});
  expect(ipc.savedQueryWrite).not.toHaveBeenCalled();
});

test("a linked tab shows the modified dot until it is saved again", async () => {
  await setup({ title: "report", sql: "select 1", savedName: "report", savedSql: "select 1" }, [sq("report")]);
  expect(screen.queryByLabelText(S.modified)).toBeNull();
  await userEvent.type(screen.getByRole("textbox", { name: "SQL editor" }), " + 1");
  expect(screen.getByLabelText(S.modified)).toBeInTheDocument();
  pressModS();
  await waitFor(() => expect(ipc.savedQueryWrite).toHaveBeenCalledWith("c1", "report", "select 1 + 1"));
  await waitFor(() => expect(screen.queryByLabelText(S.modified)).toBeNull());
});

test("rename (from the menu) updates the file and the linked tab", async () => {
  await setupPanel({ title: "old", savedName: "old", savedSql: "select 1" }, [sq("old")]);
  await userEvent.click(within(await openMenu("old")).getByRole("menuitem", { name: Q.rename }));
  const dialog = screen.getByRole("dialog", { name: S.renameTitle });
  const input = within(dialog).getByRole("textbox", { name: S.nameLabel });
  expect(input).toHaveValue("old");
  await userEvent.clear(input);
  await userEvent.type(input, "new");
  vi.mocked(ipc.savedQueriesList).mockResolvedValue([sq("new")]);
  await userEvent.click(within(dialog).getByRole("button", { name: S.renameConfirm }));
  await waitFor(() => expect(ipc.savedQueryRename).toHaveBeenCalledWith("c1", "old", "new"));
  await waitFor(() => expect(tab0()).toMatchObject({ title: "new", savedName: "new" }));
  expect(await screen.findByRole("button", { name: S.open("new") })).toBeInTheDocument();
});

test("delete (from the menu) asks for confirmation and unlinks the tab", async () => {
  await setupPanel({ title: "gone", savedName: "gone", savedSql: "select 1" }, [sq("gone")]);
  await userEvent.click(within(await openMenu("gone")).getByRole("menuitem", { name: Q.delete }));
  const confirm = screen.getByRole("alertdialog", { name: S.deleteTitle });
  expect(confirm).toHaveAttribute("aria-modal", "true");
  vi.mocked(ipc.savedQueriesList).mockResolvedValue([]);
  await userEvent.click(within(confirm).getByRole("button", { name: S.deleteConfirm }));
  await waitFor(() => expect(ipc.savedQueryDelete).toHaveBeenCalledWith("c1", "gone"));
  await waitFor(() => expect(tab0().savedName ?? null).toBeNull());
  expect(tab0().title).toBe("gone");
});

test("query_click_opens_sql_tab: a click opens the query in a new linked tab, or activates the tab already linked", async () => {
  await setupPanel({}, [sq("users")]);
  vi.mocked(ipc.savedQueryRead).mockResolvedValue("select * from users");
  await userEvent.click(screen.getByRole("button", { name: S.open("users") }));
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(2));
  const ws = useWorkspaces.getState().workspaces[0];
  const opened = ws.tabs[1] as QueryTabT;
  expect(opened).toMatchObject({ title: "users", sql: "select * from users", savedName: "users" });
  expect(ws.activeTabId).toBe(opened.id);
  // Back to the first tab, then open again: the linked tab is reused.
  act(() => useWorkspaces.getState().activateTab("w1", "t1"));
  await userEvent.click(await screen.findByRole("button", { name: S.open("users") }));
  expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(2);
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe(opened.id);
  expect(ipc.savedQueryRead).toHaveBeenCalledTimes(1);
});

test("the menu: Run opens the query and runs it, Copy copies its text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await setupPanel({}, [sq("users")]);
  vi.mocked(ipc.savedQueryRead).mockResolvedValue("select * from users");
  const menu = await openMenu("users");
  expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
    Q.run,
    Q.copy,
    Q.insert,
    Q.rename,
    Q.delete,
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: Q.copy }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("select * from users"));

  vi.mocked(ipc.sqlSessionOpen).mockResolvedValue("s1");
  vi.mocked(ipc.sqlExecute).mockResolvedValue(undefined);
  await userEvent.click(within(await openMenu("users")).getByRole("menuitem", { name: Q.run }));
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(2));
  const opened = useWorkspaces.getState().workspaces[0].tabs[1] as QueryTabT;
  expect(opened).toMatchObject({ savedName: "users", sql: "select * from users" });
  // The new tab runs it once (the request is consumed).
  await waitFor(() => expect(ipc.sqlExecute).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ipc.sqlExecute).mock.calls[0][1]).toEqual(["select * from users"]);
  expect(useChrome.getState().runRequests[opened.id]).toBeUndefined();
});

test("the menu: Insert into SQL editor inserts in the active SQL tab", async () => {
  await setupPanel({ sql: "" }, [sq("users")]);
  vi.mocked(ipc.savedQueryRead).mockResolvedValue("select 7");
  await userEvent.click(within(await openMenu("users")).getByRole("menuitem", { name: Q.insert }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "SQL editor" })).toHaveValue("select 7"));
  expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(1);
});

test("the search box filters the saved queries", async () => {
  await setupPanel({}, [sq("daily report"), sq("users")]);
  await userEvent.type(screen.getByRole("searchbox", { name: S.search }), "DAILY");
  expect(screen.getByRole("button", { name: S.open("daily report") })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: S.open("users") })).toBeNull();
  await userEvent.type(screen.getByRole("searchbox", { name: S.search }), "zzz");
  expect(screen.getByText(S.noMatch)).toBeInTheDocument();
});

test("the menu gives the focus back to its query on Escape", async () => {
  await setupPanel({}, [sq("users")]);
  await openMenu("users");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: S.open("users") })).toHaveFocus();
});

test("Copy without a clipboard reports the failure", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  await setupPanel({}, [sq("users")]);
  vi.mocked(ipc.savedQueryRead).mockResolvedValue("select 1");
  await userEvent.click(within(await openMenu("users")).getByRole("menuitem", { name: Q.copy }));
  expect(await screen.findByRole("alert")).toHaveTextContent(S.actionFailed(strings.sidebar.clipboardUnavailable));
});
