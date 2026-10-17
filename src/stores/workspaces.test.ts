import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { ConnectionConfig } from "../lib/types";
import { useConnections } from "./connections";
import { useGridViews } from "./gridViews";
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
  database: null,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null });
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
