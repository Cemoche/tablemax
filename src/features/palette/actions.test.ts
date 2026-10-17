import { beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import type { Workspace } from "../../stores/workspaces";
import { useWorkspaces } from "../../stores/workspaces";
import { registerEditorCommands } from "../editor/editorCommands";
import { type ActionCtx, formatShortcut, visibleActions } from "./actions";

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
  // Without a workspace only "New connection" remains.
  expect(titles(ctx(null))).toEqual([t.newConnection]);
  // "Change database" is PostgreSQL only.
  expect(titles(ctx(ws()))).toContain(t.changeDatabase);
  expect(titles(ctx(ws({ dialect: "sqlite" })))).not.toContain(t.changeDatabase);
  expect(titles(ctx(ws({ dialect: "mySql" })))).not.toContain(t.changeDatabase);
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

test("shortcuts are rendered per platform", () => {
  expect(formatShortcut("Mod+Shift+F")).toBe("Ctrl+Shift+F");
  expect(formatShortcut("Ctrl+Tab")).toBe("Ctrl+Tab");
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  expect(formatShortcut("Mod+Shift+F")).toBe("⌘⇧F");
  expect(formatShortcut("Ctrl+Tab")).toBe("⌃Tab");
  spy.mockRestore();
});
