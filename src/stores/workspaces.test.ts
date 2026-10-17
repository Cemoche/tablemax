import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import { strings } from "../lib/strings";
import type { ConnectionConfig } from "../lib/types";
import { useConnections } from "./connections";
import { useGridViews } from "./gridViews";
import { usePendingChanges } from "./pendingChanges";
import { useQueryRuns } from "./queryRuns";
import { type Workspace, useWorkspaces } from "./workspaces";

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
  database: null,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null, closeRequest: null, connectRequest: null });
  usePendingChanges.setState({ tabs: {}, blocked: {}, committing: {}, applied: {}, editorOpen: {}, awaitingReload: {}, epoch: {} });
  useGridViews.setState({ views: {} });
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

test("the workspace keeps the tag and safe mode it was opened with", async () => {
  useConnections.setState({ items: [cfg({ envTag: "prod", safeMode: "confirmAll" })] });
  await open();
  expect(ws()).toMatchObject({ envTag: "prod", safeMode: "confirmAll" });
  // A later edit of the saved connection does not rewrite what the workspace was opened with.
  useConnections.setState({ items: [cfg({ envTag: "dev", safeMode: "off" })] });
  expect(ws()).toMatchObject({ envTag: "prod", safeMode: "confirmAll" });
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
    preview: false,
  });
  expect(useGridViews.getState().getTrail(table.id)).toEqual(trail);
  // Query tabs have no object: unchanged.
  useWorkspaces.getState().navigateTableTab(id, query.id, { schema: "x", name: "y" }, view, trail);
  expect(ws().tabs[1]).toEqual(query);
  expect(useGridViews.getState().getTrail(query.id)).toEqual([]);
});

const users = { schema: "public", name: "users" };
const orders = { schema: "public", name: "orders" };
const previews = () => ws().tabs.filter((t) => t.kind === "table" && t.preview);

test("two single clicks leave one preview tab showing the second object", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users, { preview: true });
  s.openTableTab(id, orders, { preview: true });
  expect(ws().tabs).toHaveLength(1);
  expect(ws().tabs[0]).toMatchObject({ kind: "table", object: orders, preview: true });
  expect(ws().activeTabId).toBe(ws().tabs[0].id);
  expect(ws().mru).toEqual([ws().tabs[0].id]);
});

test("a preview tab does not replace a pinned tab and opens next to it", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users);
  s.openTableTab(id, orders, { preview: true });
  expect(ws().tabs.map((t) => t.title)).toEqual(["users", "orders"]);
  expect(ws().tabs[0]).toMatchObject({ preview: false });
});

test("a single click on an object already pinned activates it, no preview duplicate", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users);
  s.openTableTab(id, orders);
  s.openTableTab(id, users, { preview: true });
  expect(ws().tabs).toHaveLength(2);
  expect(previews()).toHaveLength(0);
  expect(ws().activeTabId).toBe(ws().tabs[0].id);
});

test("a double click pins the preview tab of that object", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users, { preview: true });
  s.openTableTab(id, users, { preview: false });
  expect(ws().tabs).toHaveLength(1);
  expect(ws().tabs[0]).toMatchObject({ preview: false });
  s.openTableTab(id, orders, { preview: true });
  expect(ws().tabs.map((t) => t.title)).toEqual(["users", "orders"]);
});

test("pinTab pins a preview tab", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users, { preview: true });
  s.pinTab(id, ws().tabs[0].id);
  expect(ws().tabs[0]).toMatchObject({ preview: false });
  s.openTableTab(id, orders, { preview: true });
  expect(ws().tabs).toHaveLength(2);
});

test("the first sort or page change in a preview tab pins it", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users, { preview: true });
  s.openTableTab(id, orders);
  const [pv, pinned] = ws().tabs.map((t) => t.id);
  useGridViews.getState().setView(pinned, { page: 1 });
  expect(ws().tabs[0]).toMatchObject({ preview: true });
  useGridViews.getState().setView(pv, { sort: ["id", "asc"] });
  expect(ws().tabs[0]).toMatchObject({ preview: false });
});

test("a pending change pins a preview tab; opening or viewing it does not", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users, { preview: true });
  s.openTableTab(id, orders);
  const [pv, pinned] = ws().tabs.map((t) => t.id);
  usePendingChanges.getState().addInsert(pinned, orders);
  expect(ws().tabs[0]).toMatchObject({ preview: true });
  usePendingChanges.getState().addInsert(pv, users);
  expect(ws().tabs[0]).toMatchObject({ preview: false });
  // The next single click opens a new preview tab instead of replacing the edited one.
  s.openTableTab(id, { schema: "public", name: "items" }, { preview: true });
  expect(ws().tabs).toHaveLength(3);
  expect(usePendingChanges.getState().count(pv)).toBe(1);
});

test("filtering a preview tab pins it", async () => {
  const id = await open();
  useWorkspaces.getState().openTableTab(id, users, { preview: true });
  const pv = ws().tabs[0].id;
  useGridViews.getState().setView(pv, { filters: [{ column: "id", op: "eq", values: ["1"] }], page: 0 });
  expect(ws().tabs[0]).toMatchObject({ preview: false });
});

test("following a foreign key in a preview tab pins it", async () => {
  const id = await open();
  useWorkspaces.getState().openTableTab(id, orders, { preview: true });
  const pv = ws().tabs[0].id;
  const view = { page: 0, sort: null, filters: [{ column: "id", op: "eq" as const, values: ["42"] }] };
  useWorkspaces.getState().navigateTableTab(id, pv, users, view, [{ object: orders, view: { page: 0, sort: null, filters: [] } }]);
  expect(ws().tabs[0]).toMatchObject({ object: users, preview: false });
  useWorkspaces.getState().openTableTab(id, { schema: "public", name: "items" }, { preview: true });
  expect(ws().tabs.map((t) => t.title)).toEqual(["users", "items"]);
});

test("replacing a preview tab drops its grid view and mru entry", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users, { preview: true });
  const first = ws().tabs[0].id;
  s.openTableTab(id, orders, { preview: true });
  expect(useGridViews.getState().views[first]).toBeUndefined();
  expect(ws().mru).not.toContain(first);
});

test("mru lists tabs most recently used first, query tabs included", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, users);
  s.openQueryTab(id);
  s.openTableTab(id, orders);
  const [a, b, c] = ws().tabs.map((t) => t.id);
  expect(ws().mru).toEqual([c, b, a]);
  s.activateTab(id, a);
  expect(ws().mru).toEqual([a, c, b]);
  s.openTableTab(id, orders); // already open: activates and bumps
  expect(ws().mru).toEqual([c, a, b]);
});

test("closing the active tab activates the previous one in mru", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  for (let i = 0; i < 3; i++) s.openQueryTab(id);
  const [a, b, c] = ws().tabs.map((t) => t.id);
  s.activateTab(id, a);
  s.activateTab(id, c);
  s.closeTab(id, c);
  expect(ws().activeTabId).toBe(a);
  expect(ws().mru).toEqual([a, b]);
  s.closeTab(id, b); // inactive: the active tab is kept
  expect(ws().activeTabId).toBe(a);
  expect(ws().mru).toEqual([a]);
});

// ---- Restored (disconnected) workspaces ----

const restored = (over: Partial<Workspace> = {}): Workspace => ({
  id: "restored:1",
  connectionId: "c1",
  name: "Local PG",
  color: "swatch-1",
  envTag: "dev",
  dialect: "postgres",
  status: "disconnected",
  database: null,
  schemas: ["audit"],
  currentSchema: "audit",
  tabs: [
    { id: "t1", kind: "table", object: { schema: "audit", name: "log" }, title: "log", preview: true },
    { id: "t2", kind: "query", title: "Query 2", sql: "select 1", sqlSessionId: null },
  ],
  activeTabId: "t1",
  mru: ["t1", "t2"],
  ...over,
});
const restore = (over: Partial<Workspace> = {}) => {
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null });
  useWorkspaces.getState().restoreWorkspaces([restored(over)], "restored:1");
};

test("a newly opened workspace is connected and remembers its database", async () => {
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ database: "app" }));
  await open();
  expect(ws()).toMatchObject({ status: "connected", database: "app" });
});

test("openWorkspace connects a disconnected workspace in place, keeping its tabs", async () => {
  restore();
  await useWorkspaces.getState().openWorkspace("c1", "pw");
  expect(ipc.workspaceOpen).toHaveBeenCalledWith("c1", "pw", null, null);
  expect(useWorkspaces.getState().workspaces).toHaveLength(1);
  expect(ws()).toMatchObject({
    id: "w1",
    status: "connected",
    schemas: ["audit", "public"],
    currentSchema: "audit",
    activeTabId: "t1",
    mru: ["t1", "t2"],
  });
  expect(ws().tabs).toEqual(restored().tabs);
  expect(useWorkspaces.getState().activeWorkspaceId).toBe("w1");
  // Numbering carries over to the new id.
  useWorkspaces.getState().openQueryTab("w1");
  expect(ws().tabs[2].title).toBe("Query 3");
});

test("a restored schema that no longer exists falls back to the default one", async () => {
  restore({ currentSchema: "gone", schemas: ["gone"] });
  await useWorkspaces.getState().openWorkspace("c1");
  expect(ws().currentSchema).toBe("public");
});

test("status is connecting during the connect and back to disconnected on error", async () => {
  restore();
  let fail!: (e: unknown) => void;
  vi.mocked(ipc.workspaceOpen).mockReturnValue(new Promise((_, rej) => (fail = rej)));
  const p = useWorkspaces.getState().openWorkspace("c1");
  expect(ws().status).toBe("connecting");
  // A second open while connecting does not open twice.
  const p2 = useWorkspaces.getState().openWorkspace("c1");
  fail({ kind: "auth", message: "password required" });
  await expect(p).rejects.toMatchObject({ message: "password required" });
  await expect(p2).rejects.toMatchObject({ message: "password required" });
  expect(ipc.workspaceOpen).toHaveBeenCalledTimes(1);
  expect(ws()).toMatchObject({ id: "restored:1", status: "disconnected" });
  expect(ws().tabs).toHaveLength(2);
});

test("a failed schema list closes the backend workspace and stays disconnected", async () => {
  restore();
  vi.mocked(ipc.schemasList).mockRejectedValue({ kind: "connection", message: "boom" });
  await expect(useWorkspaces.getState().openWorkspace("c1")).rejects.toMatchObject({ message: "boom" });
  expect(ipc.workspaceClose).toHaveBeenCalledWith("w1");
  expect(ws()).toMatchObject({ id: "restored:1", status: "disconnected" });
});

test("postgres switches back to the restored database", async () => {
  restore({ database: "other" });
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ database: "app" }));
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue(info({ database: "other" }));
  await useWorkspaces.getState().openWorkspace("c1");
  expect(ipc.workspaceSwitchDatabase).toHaveBeenCalledWith("w1", "other");
  expect(ipc.schemasList).toHaveBeenCalledWith("w1");
  expect(vi.mocked(ipc.workspaceSwitchDatabase).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(ipc.schemasList).mock.invocationCallOrder[0],
  );
  expect(ws()).toMatchObject({ status: "connected", database: "other" });
});

test("a failed database switch connects on the default database, closes the table tabs and says so", async () => {
  restore({ database: "dropped" });
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ database: "app" }));
  vi.mocked(ipc.workspaceSwitchDatabase).mockRejectedValue({ kind: "notFound", message: "no db" });
  await useWorkspaces.getState().openWorkspace("c1");
  expect(ws()).toMatchObject({ status: "connected", database: "app", currentSchema: "audit" });
  // The table tabs would show the default database's tables under the old titles.
  expect(ws().tabs.map((t) => t.id)).toEqual(["t2"]);
  expect(ws()).toMatchObject({ activeTabId: "t2", mru: ["t2"] });
  expect(ws().notice).toBe(strings.session.databaseFallback("dropped", "app"));
  useWorkspaces.getState().dismissNotice("w1");
  expect(ws().notice).toBeNull();
});

test("query tabs record the database their session was opened on, and keep it across a switch", async () => {
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ database: "app" }));
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue(info({ database: "other" }));
  const id = await open();
  useWorkspaces.getState().openQueryTab(id);
  const tabId = ws().tabs[0].id;
  useWorkspaces.getState().updateTab(id, tabId, { sqlSessionId: "s1", database: "app" });
  await useWorkspaces.getState().switchDatabase(id, "other");
  expect(ws().database).toBe("other");
  expect(ws().tabs[0]).toMatchObject({ kind: "query", sqlSessionId: "s1", database: "app" });
});

test("the same database or a mysql workspace does not switch", async () => {
  restore({ database: "app" });
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ database: "app" }));
  await useWorkspaces.getState().openWorkspace("c1");
  restore({ database: "shop", dialect: "mySql" });
  vi.mocked(ipc.workspaceOpen).mockResolvedValue(info({ dialect: "mySql", database: null }));
  await useWorkspaces.getState().openWorkspace("c1");
  expect(ipc.workspaceSwitchDatabase).not.toHaveBeenCalled();
});

test("closing a disconnected workspace does not call the backend", async () => {
  restore();
  await useWorkspaces.getState().closeWorkspace("restored:1");
  expect(ipc.workspaceClose).not.toHaveBeenCalled();
  expect(useWorkspaces.getState().workspaces).toHaveLength(0);
});

test("a workspace closed while connecting closes the backend one when it arrives", async () => {
  restore();
  let done!: (v: ReturnType<typeof info>) => void;
  vi.mocked(ipc.workspaceOpen).mockReturnValue(new Promise((r) => (done = r)));
  const p = useWorkspaces.getState().openWorkspace("c1");
  await useWorkspaces.getState().closeWorkspace("restored:1");
  expect(ipc.workspaceClose).not.toHaveBeenCalled();
  done(info());
  await p;
  expect(ipc.workspaceClose).toHaveBeenCalledWith("w1");
  expect(useWorkspaces.getState().workspaces).toHaveLength(0);
});

test("activating a tab or selecting a disconnected workspace requests a connect", async () => {
  restore();
  useWorkspaces.getState().activateTab("restored:1", "t2");
  expect(useWorkspaces.getState().connectRequest).toEqual({ workspaceId: "restored:1" });
  expect(ws().activeTabId).toBe("t2");
  useWorkspaces.getState().clearConnectRequest();
  useWorkspaces.getState().setActiveWorkspace("restored:1");
  expect(useWorkspaces.getState().connectRequest).toEqual({ workspaceId: "restored:1" });
  useWorkspaces.getState().clearConnectRequest();
  useWorkspaces.setState({ workspaces: [restored({ status: "connecting" })] });
  useWorkspaces.getState().activateTab("restored:1", "t1");
  expect(useWorkspaces.getState().connectRequest).toBeNull();
});

test("a connected workspace never requests a connect", async () => {
  const id = await open();
  useWorkspaces.getState().openQueryTab(id);
  useWorkspaces.getState().activateTab(id, ws().tabs[0].id);
  useWorkspaces.getState().setActiveWorkspace(id);
  expect(useWorkspaces.getState().connectRequest).toBeNull();
});

test("restoreWorkspaces skips a connection already open and keeps the active workspace", async () => {
  const id = await open();
  useWorkspaces.getState().restoreWorkspaces(
    [restored(), restored({ id: "restored:2", connectionId: "c2" })],
    "restored:1",
  );
  expect(useWorkspaces.getState().workspaces.map((w) => w.id)).toEqual([id, "restored:2"]);
  expect(useWorkspaces.getState().activeWorkspaceId).toBe(id);
});

test("switchDatabase closes table tabs, keeps query tabs and updates database and schemas", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, { schema: "public", name: "t1" });
  s.openTableTab(id, { schema: "public", name: "t2" }, { preview: true });
  s.openQueryTab(id);
  const q = ws().tabs.find((t) => t.kind === "query")?.id;
  const dropView = vi.spyOn(useGridViews.getState(), "dropView");
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue(info({ database: "other" }));
  vi.mocked(ipc.schemasList).mockResolvedValue(["public", "x"]);
  await useWorkspaces.getState().switchDatabase(id, "other");
  expect(ws().tabs.map((t) => t.id)).toEqual([q]);
  expect(ws().mru).toEqual([q]);
  expect(ws().activeTabId).toBe(q);
  expect(dropView).toHaveBeenCalledTimes(2);
  expect(ws()).toMatchObject({ database: "other", schemas: ["public", "x"], currentSchema: "public" });
});

test("switchDatabase refuses while a table tab has pending changes, before any backend call", async () => {
  const id = await open();
  const s = useWorkspaces.getState();
  s.openTableTab(id, obj);
  s.openTableTab(id, { schema: "public", name: "u" });
  const [t, u] = ws().tabs;
  usePendingChanges.getState().addInsert(t.id, obj);
  usePendingChanges.getState().addInsert(u.id, obj);
  usePendingChanges.getState().addInsert(u.id, obj);
  await expect(useWorkspaces.getState().switchDatabase(id, "other")).rejects.toEqual({
    kind: "invalid",
    message: strings.workspace.switchDatabasePending(3),
  });
  // Nothing switched, nothing closed, nothing dropped.
  expect(ipc.workspaceSwitchDatabase).not.toHaveBeenCalled();
  expect(ws().tabs).toHaveLength(2);
  expect(useWorkspaces.getState().closeRequest).toBeNull();
  expect(usePendingChanges.getState().count(u.id)).toBe(2);
  // Once committed or discarded, the switch goes through.
  usePendingChanges.getState().drop(t.id);
  usePendingChanges.getState().drop(u.id);
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue(info({ database: "other" }));
  await useWorkspaces.getState().switchDatabase(id, "other");
  expect(ws().tabs).toHaveLength(0);
  expect(ws().database).toBe("other");
});

test("switchDatabase keeps the store on the new database when schemasList fails", async () => {
  const id = await open();
  vi.mocked(ipc.workspaceSwitchDatabase).mockResolvedValue(info({ database: "other" }));
  vi.mocked(ipc.schemasList).mockRejectedValue({ kind: "io", message: "boom" });
  await expect(useWorkspaces.getState().switchDatabase(id, "other")).rejects.toBeTruthy();
  expect(ws()).toMatchObject({ database: "other", schemas: [], currentSchema: null });
});

test("switchDatabase failure leaves the workspace untouched; concurrent calls are ignored", async () => {
  const id = await open();
  useWorkspaces.getState().openTableTab(id, { schema: "public", name: "t1" });
  vi.mocked(ipc.workspaceSwitchDatabase).mockRejectedValueOnce({ kind: "invalid", message: "nope" });
  await expect(useWorkspaces.getState().switchDatabase(id, "other")).rejects.toBeTruthy();
  expect(ws().tabs).toHaveLength(1);
  let release: (v: ReturnType<typeof info>) => void = () => {};
  vi.mocked(ipc.workspaceSwitchDatabase).mockReturnValueOnce(new Promise((r) => (release = r)));
  const first = useWorkspaces.getState().switchDatabase(id, "a");
  await useWorkspaces.getState().switchDatabase(id, "b");
  release(info({ database: "a" }));
  await first;
  expect(ipc.workspaceSwitchDatabase).toHaveBeenCalledTimes(2);
});

test("toggleSidebar flips the app-level sidebar flag", () => {
  useWorkspaces.setState({ sidebarVisible: true });
  useWorkspaces.getState().toggleSidebar();
  expect(useWorkspaces.getState().sidebarVisible).toBe(false);
  useWorkspaces.getState().toggleSidebar();
  expect(useWorkspaces.getState().sidebarVisible).toBe(true);
});
