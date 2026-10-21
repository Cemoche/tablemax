import { beforeEach, expect, test, vi } from "vitest";
import { isKeymapActionId } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import type { Capabilities } from "../../lib/types";
import type { Workspace } from "../../stores/workspaces";
import { useWorkspaces } from "../../stores/workspaces";
import { registerEditorCommands } from "../editor/editorCommands";
import { ACTIONS, type ActionCtx, visibleActions } from "./actions";

vi.mock("../../lib/ipc");

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  database: "app",
  schemas: ["public", "audit"],
  currentSchema: "public",
  tabs: [
    { id: "q1", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
    { id: "q2", kind: "query", title: "Query 2", sql: "", sqlSessionId: null },
  ],
  activeTabId: "q1",
  mru: ["q1", "q2"],
  ...over,
});

const ctx = (w: Workspace | null, over: Partial<ActionCtx> = {}): ActionCtx => ({
  workspace: w,
  tab: w?.tabs.find((t) => t.id === w.activeTabId) ?? null,
  newConnection: vi.fn(),
  showConnections: vi.fn(),
  openSqliteFile: vi.fn(),
  pickSchema: vi.fn(),
  pickDatabase: vi.fn(),
  ...over,
});

const titles = (c: ActionCtx) => visibleActions(c).map((a) => a.title);

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null, sidebarVisible: true });
});

test("an action whose when() is false is hidden", () => {
  const t = strings.palette.action;
  // Without a workspace only "New connection", "Show connections" and "Open SQLite file…" remain.
  expect(titles(ctx(null))).toEqual([t.newConnection, t.showConnections, t.openSqliteFile]);
  // "Change database" is PostgreSQL only.
  expect(titles(ctx(ws()))).toContain(t.changeDatabase);
  expect(titles(ctx(ws({ dialect: "sqlite" })))).not.toContain(t.changeDatabase);
  expect(titles(ctx(ws({ dialect: "mySql" })))).not.toContain(t.changeDatabase);
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
  throughput: false,
};

test("capabilities decide: no SQL editor, no New SQL tab; no database switch, no Change database", () => {
  const t = strings.palette.action;
  const docs = titles(ctx(ws({ dialect: null, capabilities: NO_SQL })));
  expect(docs).not.toContain(t.newQuery);
  expect(docs).not.toContain(t.changeDatabase);
  expect(visibleActions(ctx(ws({ dialect: null, capabilities: NO_SQL }))).map((a) => a.id)).not.toContain(
    "query.new",
  );
  // The capabilities win over the dialect.
  const pgNoSwitch = titles(ctx(ws({ capabilities: { ...NO_SQL, sqlEditor: true, documents: false } })));
  expect(pgNoSwitch).toContain(t.newQuery);
  expect(pgNoSwitch).not.toContain(t.changeDatabase);
});

test("Format query and Toggle comment need a registered editor command", () => {
  const t = strings.palette.action;
  expect(titles(ctx(ws()))).not.toContain(t.toggleComment);
  expect(titles(ctx(ws()))).not.toContain(t.format);
  const off = registerEditorCommands("q1", { toggleComment: vi.fn() });
  expect(titles(ctx(ws()))).toContain(t.toggleComment);
  expect(titles(ctx(ws()))).not.toContain(t.format);
  off();
});

test("tab actions need tabs to move between", () => {
  const t = strings.palette.action;
  const one = ws({ tabs: [ws().tabs[0]], mru: ["q1"] });
  expect(titles(ctx(one))).not.toContain(t.nextTab);
  expect(titles(ctx(one))).toContain(t.closeTab);
  expect(titles(ctx(ws({ activeTabId: null })))).not.toContain(t.closeTab);
  expect(titles(ctx(ws()))).toContain(t.nextTab);
});

test("next and previous follow the MRU order like Ctrl+Tab", () => {
  useWorkspaces.setState({ workspaces: [ws()], activeWorkspaceId: "w1" });
  const c = ctx(ws());
  const next = visibleActions(c).find((a) => a.id === "tab.next");
  next?.run(c);
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("q2");
  // From q1 (as in `c`), the previous tab is the least recently used one.
  const prev = visibleActions(c).find((a) => a.id === "tab.previous");
  prev?.run(c);
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("q2");
});

test("the palette actions with a shortcut are the keymap registry's actions of the same id", () => {
  expect(ACTIONS.filter((a) => isKeymapActionId(a.id)).map((a) => a.id)).toEqual([
    "query.new",
    "tab.close",
    "tab.next",
    "tab.previous",
    "connection.new",
    "connection.open",
    "editor.format",
    "editor.comment",
    "sidebar.toggle",
    "history.toggle",
  ]);
  expect(ACTIONS.some((a) => "shortcut" in a)).toBe(false);
});

test("shortcuts are rendered per platform", () => {
  expect(formatShortcut("Mod+Shift+F")).toBe("Ctrl+Shift+F");
  expect(formatShortcut("Ctrl+Tab")).toBe("Ctrl+Tab");
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  expect(formatShortcut("Mod+Shift+F")).toBe("⌘+Shift+F");
  expect(formatShortcut("Ctrl+Tab")).toBe("Ctrl+Tab");
  spy.mockRestore();
});

test("Open history shows the sidebar on its History tab, in any connected workspace", async () => {
  const { useSidebar } = await import("../../stores/sidebar");
  const t = strings.palette.action;
  useSidebar.setState({ segments: {} });
  useWorkspaces.setState({ sidebarVisible: false });
  const tableTab = ws({
    tabs: [{ id: "t1", kind: "table", object: { schema: "public", name: "x" }, title: "x", preview: false }],
    activeTabId: "t1",
  });
  const action = visibleActions(ctx(tableTab)).find((a) => a.title === t.openHistory);
  expect(action?.id).toBe("history.toggle");
  action?.run(ctx(tableTab));
  expect(useWorkspaces.getState().sidebarVisible).toBe(true);
  expect(useSidebar.getState().segments.w1).toBe("history");
  expect(titles(ctx(ws({ status: "disconnected" })))).not.toContain(t.openHistory);
});

test("Open SQLite file… is in the palette, available anywhere, without a shortcut (#117)", () => {
  const c = ctx(null);
  const action = visibleActions(c).find((a) => a.title === strings.palette.action.openSqliteFile);
  expect(action?.id).toBe("connection.openSqliteFile");
  expect(isKeymapActionId("connection.openSqliteFile")).toBe(false);
  action?.run(c);
  expect(c.openSqliteFile).toHaveBeenCalled();
  expect(titles(ctx(ws()))).toContain(strings.palette.action.openSqliteFile);
});

test("Show connections is connection.open's entry, available anywhere (#119)", () => {
  const c = ctx(null);
  const action = visibleActions(c).find((a) => a.title === strings.palette.action.showConnections);
  expect(action?.id).toBe("connection.open");
  action?.run(c);
  expect(c.showConnections).toHaveBeenCalled();
  expect(titles(ctx(ws()))).toContain(strings.palette.action.showConnections);
});
