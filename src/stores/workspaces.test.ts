import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { ConnectionConfig } from "../lib/types";
import { useConnections } from "./connections";
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
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null });
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
