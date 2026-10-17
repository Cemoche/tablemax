import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { ConnectionConfig } from "../lib/types";
import { useConnections } from "./connections";
import { useGridViews } from "./gridViews";
import { usePendingChanges } from "./pendingChanges";
import { useQueryRuns } from "./queryRuns";
import { useWorkspaces } from "./workspaces";

vi.mock("../lib/ipc");

const cfg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "c1",
  name: "Local PG",
  color: "swatch-1",
  envTag: "dev",
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  ...over,
});

const info = (over = {}) => ({
  workspaceId: "w1",
  connectionId: "c1",
  dialect: "postgres" as const,
  serverVersion: "16",
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null, closeRequest: null });
  usePendingChanges.setState({ tabs: {}, blocked: {}, committing: {}, applied: {}, editorOpen: {}, awaitingReload: {}, epoch: {} });
  useConnections.setState({ items: [cfg()] });
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info());
  vi.mocked(ipc.schemasList).mockResolvedValue(["audit", "public"]);
  vi.mocked(ipc.sqlSessionClose).mockResolvedValue(undefined);
  vi.mocked(ipc.workspaceClose).mockResolvedValue(undefined);
});

const open = async () => {
  await useWorkspaces.getState().openWorkspace("c1");
  return useWorkspaces.getState().workspaces[0].id;
};
const obj = { schema: "public", name: "t" };
const ws = () => useWorkspaces.getState().workspaces[0];

test("openWorkspace forwards the secrets and the accepted fingerprint", async () => {
  await useWorkspaces.getState().openWorkspace("c1", "pw", "ssh-pw", "SHA256:fp");
  expect(ipc.workspaceOpen).toHaveBeenCalledWith("c1", "pw", "ssh-pw", "SHA256:fp");
});

test("openWorkspace picks public for postgres and activates; reopening just activates", async () => {
  await open();
  expect(ws().currentSchema).toBe("public");
  expect(ws().name).toBe("Local PG");
  expect(ws().envTag).toBe("dev");
  await useWorkspaces.getState().openWorkspace("c1");
  expect(ipc.workspaceOpen).toHaveBeenCalledTimes(1);
  expect(useWorkspaces.getState().workspaces).toHaveLength(1);
});

test("mysql default schema is the connection database when present", async () => {
  useConnections.setState({ items: [cfg({ kind: "mySql", database: "shop" })] });
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ dialect: "mySql" }));
  vi.mocked(ipc.schemasList).mockResolvedValue(["mysql", "shop"]);
  await open();
  expect(ws().currentSchema).toBe("shop");
});

test("sqlite default schema is main", async () => {
  useConnections.setState({ items: [cfg({ kind: "sqlite" })] });
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ dialect: "sqlite" }));
  vi.mocked(ipc.schemasList).mockResolvedValue(["main"]);
  await open();
  expect(ws().currentSchema).toBe("main");
});

test("opening the same table twice activates the existing tab", async () => {
  const id = await open();
  const { openTableTab } = useWorkspaces.getState();
  openTableTab(id, { schema: "public", name: "users" });
  openTableTab(id, { schema: "public", name: "orders" });
  openTableTab(id, { schema: "public", name: "users" });
  expect(ws().tabs).toHaveLength(2);
  expect(ws().activeTabId).toBe(ws().tabs[0].id);
});

test("can open 200 tabs without limit", async () => {
  const id = await open();
  for (let i = 0; i < 200; i++) useWorkspaces.getState().openQueryTab(id);
  expect(ws().tabs.length).toBe(200);
});

test("query tab titles count up and are never reused", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openQueryTab(id);
  s.openQueryTab(id);
  s.closeTab(id, ws().tabs[1].id);
  s.openQueryTab(id);
  expect(ws().tabs.map((t) => t.title)).toEqual(["Query 1", "Query 3"]);
});

test("closing a query tab closes its SQL session", async () => {
  const id = await open();
  useWorkspaces.getState().openQueryTab(id);
  const tab = ws().tabs[0];
  useWorkspaces.setState((st) => ({
    workspaces: st.workspaces.map((w) => ({
      ...w,
      tabs: w.tabs.map((t) => (t.kind === "query" ? { ...t, sqlSessionId: "s9" } : t)),
    })),
  }));
  useWorkspaces.getState().closeTab(id, tab.id);
  expect(ipc.sqlSessionClose).toHaveBeenCalledWith("s9");
  expect(ws().activeTabId).toBeNull();
});

test("closing active tab activates its right neighbour, else left", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  for (let i = 0; i < 3; i++) s.openQueryTab(id);
  const [a, b, c] = ws().tabs.map((t) => t.id);
  s.activateTab(id, b);
  s.closeTab(id, b);
  expect(ws().activeTabId).toBe(c);
  s.closeTab(id, c);
  expect(ws().activeTabId).toBe(a);
  s.activateTab(id, a);
  s.closeTab(id, a);
  expect(ws().activeTabId).toBeNull();
});

test("closing an inactive tab keeps the active one", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openQueryTab(id);
  s.openQueryTab(id);
  const [a, b] = ws().tabs.map((t) => t.id);
  s.closeTab(id, a);
  expect(ws().activeTabId).toBe(b);
});

test("closeWorkspace calls backend, drops state and moves active", async () => {
  await open();
  await useWorkspaces.getState().closeWorkspace("w1");
  expect(ipc.workspaceClose).toHaveBeenCalledWith("w1");
  expect(useWorkspaces.getState().workspaces).toHaveLength(0);
  expect(useWorkspaces.getState().activeWorkspaceId).toBeNull();
});

test("updateTab patches query tabs only", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openQueryTab(id);
  s.openTableTab(id, { schema: "public", name: "t" });
  const [q, t] = ws().tabs;
  s.updateTab(id, q.id, { sql: "select 1", sqlSessionId: "s1", title: "Mine" });
  expect(ws().tabs[0]).toMatchObject({ sql: "select 1", sqlSessionId: "s1", title: "Mine" });
  s.updateTab(id, q.id, { sqlSessionId: null });
  expect(ws().tabs[0]).toMatchObject({ sql: "select 1", sqlSessionId: null });
  s.updateTab(id, t.id, { sql: "x", title: "Nope" });
  expect(ws().tabs[1]).toEqual(t);
});

test("closing a query tab drops its run state", async () => {
  const id = await open();
  useWorkspaces.getState().openQueryTab(id);
  const tab = ws().tabs[0];
  useQueryRuns.getState().start(tab.id, 1);
  useWorkspaces.getState().closeTab(id, tab.id);
  expect(useQueryRuns.getState().runs[tab.id]).toBeUndefined();
});

test("closing a table tab with pending changes asks first", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, { schema: "public", name: "t" });
  const tab = ws().tabs[0];
  usePendingChanges.getState().addInsert(tab.id, obj);
  usePendingChanges.getState().addInsert(tab.id, obj);
  s.closeTab(id, tab.id);
  expect(ws().tabs).toHaveLength(1);
  expect(useWorkspaces.getState().closeRequest).toEqual({ wsId: id, tabId: tab.id, count: 2, tabs: 1 });
  useWorkspaces.getState().cancelClose();
  expect(useWorkspaces.getState().closeRequest).toBeNull();
  expect(usePendingChanges.getState().count(tab.id)).toBe(2);
  s.closeTab(id, tab.id);
  useWorkspaces.getState().confirmClose();
  expect(ws().tabs).toHaveLength(0);
  expect(useWorkspaces.getState().closeRequest).toBeNull();
  expect(usePendingChanges.getState().tabs[tab.id]).toBeUndefined();
});

test("closing a table tab without pending changes closes it at once", async () => {
  const id = await open();
  useWorkspaces.getState().openTableTab(id, { schema: "public", name: "t" });
  useWorkspaces.getState().closeTab(id, ws().tabs[0].id);
  expect(ws().tabs).toHaveLength(0);
  expect(useWorkspaces.getState().closeRequest).toBeNull();
});

test("closing a workspace with pending changes asks first, then drops them", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, { schema: "public", name: "t" });
  s.openTableTab(id, { schema: "public", name: "u" });
  s.openQueryTab(id);
  const [t, u] = ws().tabs;
  usePendingChanges.getState().addInsert(t.id, obj);
  usePendingChanges.getState().addInsert(u.id, obj);
  usePendingChanges.getState().addInsert(u.id, obj);
  await s.closeWorkspace(id);
  expect(ipc.workspaceClose).not.toHaveBeenCalled();
  expect(useWorkspaces.getState().closeRequest).toEqual({ wsId: id, tabId: null, count: 3, tabs: 2 });
  useWorkspaces.getState().cancelClose();
  expect(useWorkspaces.getState().workspaces).toHaveLength(1);
  await s.closeWorkspace(id);
  await useWorkspaces.getState().confirmClose();
  expect(ipc.workspaceClose).toHaveBeenCalledWith(id);
  expect(useWorkspaces.getState().workspaces).toHaveLength(0);
  expect(usePendingChanges.getState().tabs[t.id]).toBeUndefined();
  expect(usePendingChanges.getState().tabs[u.id]).toBeUndefined();
});

test("a tab or workspace whose commit is running is not closed (no discard offered)", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, { schema: "public", name: "t" });
  const tab = ws().tabs[0];
  usePendingChanges.getState().addInsert(tab.id, obj);
  usePendingChanges.setState((p) => ({ committing: { ...p.committing, [tab.id]: true } }));
  s.closeTab(id, tab.id);
  expect(ws().tabs).toHaveLength(1);
  expect(useWorkspaces.getState().closeRequest).toBeNull();
  await s.closeWorkspace(id);
  expect(useWorkspaces.getState().closeRequest).toBeNull();
  expect(ipc.workspaceClose).not.toHaveBeenCalled();
  expect(useWorkspaces.getState().isCommitting(id)).toBe(true);
  expect(useWorkspaces.getState().isCommitting(id, tab.id)).toBe(true);
  usePendingChanges.setState((p) => ({ committing: { ...p.committing, [tab.id]: false } }));
  expect(useWorkspaces.getState().isCommitting(id)).toBe(false);
  s.closeTab(id, tab.id);
  expect(useWorkspaces.getState().closeRequest).toMatchObject({ tabId: tab.id });
});

test("navigateTableTab changes the object and title of a table tab, in place", async () => {
  const id = await open();
  useWorkspaces.getState().openTableTab(id, { schema: "public", name: "orders" });
  useWorkspaces.getState().openQueryTab(id);
  const [table, query] = ws().tabs;
  const view = { page: 0, sort: null, filters: [] };
  const trail = [{ object: { schema: "public", name: "orders" }, view: { ...view, page: 3 } }];
  useWorkspaces.getState().navigateTableTab(id, table.id, { schema: "sales", name: "customers" }, view, trail);
  expect(ws().tabs[0]).toEqual({
    id: table.id,
    kind: "table",
    object: { schema: "sales", name: "customers" },
    title: "customers",
  });
  expect(useGridViews.getState().getTrail(table.id)).toEqual(trail);
  // Query tabs have no object: unchanged.
  useWorkspaces.getState().navigateTableTab(id, query.id, { schema: "x", name: "y" }, view, trail);
  expect(ws().tabs[1]).toEqual(query);
  expect(useGridViews.getState().getTrail(query.id)).toEqual([]);
});
