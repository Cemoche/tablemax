import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { ConnectionConfig } from "../lib/types";
import { useConnections } from "./connections";
import {
  type SessionSnapshot,
  parseSnapshot,
  restoreSession,
  snapshot,
  startSessionAutosave,
} from "./session";
import { type Workspace, useWorkspaces } from "./workspaces";

vi.mock("../lib/ipc");

const cfg = (id: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: `Conn ${id}`,
  color: "swatch-2",
  envTag: "staging",
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "ask",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  ...over,
});

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  connectionId: "c1",
  name: "Conn c1",
  color: "swatch-2",
  envTag: "staging",
  dialect: "postgres",
  status: "connected",
  database: "app",
  schemas: ["public", "audit"],
  currentSchema: "audit",
  tabs: [
    { id: "t1", kind: "table", object: { schema: "audit", name: "log" }, title: "log", preview: true },
    { id: "t2", kind: "query", title: "Query 3", sql: "select 1", sqlSessionId: "s1" },
  ],
  activeTabId: "t2",
  mru: ["t2", "t1"],
  ...over,
});

const snap: SessionSnapshot = {
  version: 1,
  activeWorkspaceIndex: 1,
  workspaces: [
    {
      connectionId: "c1",
      currentSchema: "audit",
      database: "app",
      activeTabIndex: 1,
      tabs: [
        { kind: "table", object: { schema: "audit", name: "log" }, preview: true },
        { kind: "query", title: "Query 3", sql: "select 1" },
      ],
    },
    { connectionId: "c2", currentSchema: null, database: null, activeTabIndex: null, tabs: [] },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null, connectRequest: null });
  useConnections.setState({ items: [cfg("c1"), cfg("c2", { kind: "mariaDb", name: "Maria" })] });
  vi.mocked(ipc.sessionSave).mockResolvedValue(undefined);
  vi.mocked(ipc.sessionLoad).mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

const state = () => useWorkspaces.getState();
const savedJson = (call = 0) => JSON.parse(vi.mocked(ipc.sessionSave).mock.calls[call][0]);

// ---- snapshot / parseSnapshot ----

test("snapshot keeps workspaces, tabs and active indices; parseSnapshot reads it back", () => {
  const s = snapshot({
    workspaces: [workspace(), workspace({ id: "w2", connectionId: "c2", tabs: [], activeTabId: null, mru: [], currentSchema: null, database: null })],
    activeWorkspaceId: "w2",
  });
  expect(s).toEqual(snap);
  expect(parseSnapshot(JSON.stringify(s))).toEqual(snap);
});

test("parseSnapshot rejects invalid JSON, unknown versions and missing fields", () => {
  const without = (path: (s: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(snap));
    path(copy);
    return JSON.stringify(copy);
  };
  expect(parseSnapshot("{not json")).toBeNull();
  expect(parseSnapshot("null")).toBeNull();
  expect(parseSnapshot("[]")).toBeNull();
  expect(parseSnapshot(JSON.stringify({ ...snap, version: 2 }))).toBeNull();
  expect(parseSnapshot(without((s) => delete s.version))).toBeNull();
  expect(parseSnapshot(without((s) => delete s.workspaces))).toBeNull();
  expect(parseSnapshot(without((s) => delete s.activeWorkspaceIndex))).toBeNull();
  expect(parseSnapshot(without((s) => ((s.workspaces as never[])[0] as Record<string, unknown>).connectionId = 3))).toBeNull();
  expect(
    parseSnapshot(without((s) => delete ((s.workspaces as { tabs: Record<string, unknown>[] }[])[0].tabs[1].sql))),
  ).toBeNull();
  expect(
    parseSnapshot(without((s) => delete ((s.workspaces as { tabs: { object: Record<string, unknown> }[] }[])[0].tabs[0].object.name))),
  ).toBeNull();
  expect(parseSnapshot(without((s) => (s.activeWorkspaceIndex = 5)))).toBeNull();
  expect(parseSnapshot(without((s) => (((s.workspaces as Record<string, unknown>[])[0].activeTabIndex = 2))))).toBeNull();
});

test("parseSnapshot ignores unknown extra fields", () => {
  const extra = JSON.parse(JSON.stringify(snap));
  extra.future = true;
  extra.workspaces[0].pinned = [1];
  extra.workspaces[0].tabs[1].pinnedAt = 3; // savedName is a known field since Plan 4 Task 8
  expect(parseSnapshot(JSON.stringify(extra))).toEqual(snap);
});

test("the snapshot holds no secret, even if a workspace object carried one", () => {
  const leaky = {
    ...workspace(),
    password: "pw",
    sshSecret: "ssh",
    acceptFingerprint: "SHA256:x",
  } as Workspace;
  const keys: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        keys.push(k);
        walk(x);
      }
    }
  };
  const s = snapshot({ workspaces: [leaky], activeWorkspaceId: "w1" });
  walk(s);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.filter((k) => /password|secret|fingerprint|session/i.test(k))).toEqual([]);
  expect(JSON.stringify(s)).not.toMatch(/pw|ssh|SHA256|s1/);
});

// ---- restoreSession ----

test("restoreSession recreates disconnected workspaces with their tabs, without connecting", async () => {
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(snap));
  await restoreSession();
  expect(ipc.workspaceOpen).not.toHaveBeenCalled();
  const [a, b] = state().workspaces;
  expect(a.id).toMatch(/^restored:/);
  expect(a).toMatchObject({
    connectionId: "c1",
    name: "Conn c1",
    color: "swatch-2",
    envTag: "staging",
    dialect: "postgres",
    status: "disconnected",
    database: "app",
    schemas: ["audit"],
    currentSchema: "audit",
  });
  expect(a.tabs).toMatchObject([
    { kind: "table", object: { schema: "audit", name: "log" }, title: "log", preview: true },
    { kind: "query", title: "Query 3", sql: "select 1", sqlSessionId: null },
  ]);
  expect(a.activeTabId).toBe(a.tabs[1].id);
  expect(a.mru[0]).toBe(a.tabs[1].id);
  expect(b).toMatchObject({ connectionId: "c2", name: "Maria", dialect: "mySql", schemas: [], tabs: [] });
  expect(state().activeWorkspaceId).toBe(b.id);
  // A new query tab continues the numbering.
  state().openQueryTab(a.id);
  expect(state().workspaces[0].tabs[2].title).toBe("Query 4");
});

test("restoreSession drops workspaces whose connection was deleted", async () => {
  useConnections.setState({ items: [cfg("c1")] });
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(snap));
  await restoreSession();
  expect(state().workspaces.map((w) => w.connectionId)).toEqual(["c1"]);
  // The active one (c2) is gone: fall back to the remaining workspace.
  expect(state().activeWorkspaceId).toBe(state().workspaces[0].id);
});

test("a restored workspace that never connects round-trips into the next snapshot unchanged", async () => {
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(snap));
  await restoreSession();
  expect(snapshot(state())).toEqual(snap);
});

test("corrupt_session_is_ignored", async () => {
  for (const bad of ["{not json", JSON.stringify({ ...snap, version: 2 }), JSON.stringify({ version: 1 })]) {
    vi.mocked(ipc.sessionLoad).mockResolvedValue(bad);
    const stop = startSessionAutosave();
    await restoreSession();
    expect(state().workspaces).toEqual([]);
    expect(state().activeWorkspaceId).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event("beforeunload"));
    expect(ipc.sessionSave).not.toHaveBeenCalled();
    stop();
  }
  // Once the user changes something, the session is written again.
  const stop = startSessionAutosave();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  stop();
});

test("a failed session_load starts empty and saves nothing", async () => {
  vi.mocked(ipc.sessionLoad).mockRejectedValue({ kind: "io", message: "disk" });
  const stop = startSessionAutosave();
  await restoreSession();
  await vi.advanceTimersByTimeAsync(5000);
  expect(state().workspaces).toEqual([]);
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  stop();
});

// ---- autosave ----

test("autosave writes one session 1 s after the last change", async () => {
  const stop = startSessionAutosave();
  await restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await vi.advanceTimersByTimeAsync(500);
  state().updateTab("w1", "t2", { sql: "select 2" });
  await vi.advanceTimersByTimeAsync(999);
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  expect(savedJson().workspaces[0].tabs[1].sql).toBe("select 2");
  await vi.advanceTimersByTimeAsync(5000);
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  stop();
});

test("autosave never saves before the initial restore finished", async () => {
  let finish!: (v: string | null) => void;
  vi.mocked(ipc.sessionLoad).mockReturnValue(new Promise((r) => (finish = r)));
  const stop = startSessionAutosave();
  const restoring = restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await vi.advanceTimersByTimeAsync(3000);
  window.dispatchEvent(new Event("beforeunload"));
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  finish(JSON.stringify(snap));
  await restoring;
  await vi.advanceTimersByTimeAsync(3000);
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  stop();
});

test("status and id changes alone do not rewrite the session", async () => {
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(snap));
  const stop = startSessionAutosave();
  await restoreSession();
  const id = state().workspaces[0].id;
  useWorkspaces.setState((s) => ({
    workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, status: "connecting" } : w)),
  }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  stop();
});

test("beforeunload saves a pending change at once", async () => {
  const stop = startSessionAutosave();
  await restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  window.dispatchEvent(new Event("beforeunload"));
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  expect(savedJson()).toEqual(snapshot(state()));
  await vi.advanceTimersByTimeAsync(2000);
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  stop();
});

test("stop unsubscribes", async () => {
  const stop = startSessionAutosave();
  await restoreSession();
  stop();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await vi.advanceTimersByTimeAsync(2000);
  window.dispatchEvent(new Event("beforeunload"));
  expect(ipc.sessionSave).not.toHaveBeenCalled();
});

// ---- Plan 4 Task 8: saved query links ----

test("a query tab linked to a saved query keeps the link in the snapshot (optional field)", () => {
  const w = workspace({
    tabs: [{ id: "t2", kind: "query", title: "report", sql: "select 2", sqlSessionId: null, savedName: "report", savedSql: "select 1" }],
    activeTabId: "t2",
  });
  const s = snapshot({ workspaces: [w], activeWorkspaceId: "w1" });
  // Only the name is persisted, never the saved text.
  expect(s.workspaces[0].tabs).toEqual([{ kind: "query", title: "report", sql: "select 2", savedName: "report" }]);
  expect(parseSnapshot(JSON.stringify(s))).toEqual(s);
  // Absent: unchanged shape. Wrong type: rejected.
  expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
  const bad = JSON.parse(JSON.stringify(s));
  bad.workspaces[0].tabs[0].savedName = 3;
  expect(parseSnapshot(JSON.stringify(bad))).toBeNull();
});

test("a restored linked tab compares with the file content, read lazily", async () => {
  const linked: SessionSnapshot = {
    version: 1,
    activeWorkspaceIndex: 0,
    workspaces: [
      {
        connectionId: "c1",
        currentSchema: null,
        database: null,
        activeTabIndex: 0,
        tabs: [
          { kind: "query", title: "report", sql: "select 2", savedName: "report" },
          { kind: "query", title: "gone", sql: "select 9", savedName: "gone" },
        ],
      },
    ],
  };
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(linked));
  vi.mocked(ipc.savedQueryRead).mockImplementation(async (_c, name) => {
    if (name === "report") return "select 1";
    throw { kind: "notFound", message: "saved query gone not found" };
  });
  await restoreSession();
  await vi.waitFor(() => {
    const [a, b] = state().workspaces[0].tabs;
    expect(a).toMatchObject({ savedName: "report", savedSql: "select 1" });
    // Deleted meanwhile: the tab is unlinked, its text stays.
    expect(b).toMatchObject({ savedName: null, sql: "select 9" });
  });
  expect(ipc.savedQueryRead).toHaveBeenCalledWith("c1", "report");
  expect(ipc.workspaceOpen).not.toHaveBeenCalled();
});

test("parseSnapshot skips tabs of an unknown kind instead of dropping the session", () => {
  const future = JSON.parse(JSON.stringify(snap));
  // Kinds from a later version, before the active tab and after it.
  future.workspaces[0].tabs.splice(0, 0, { kind: "chart", spec: {} });
  future.workspaces[0].tabs.push({ kind: "structure", object: { schema: null, name: "x" } });
  future.workspaces[0].activeTabIndex = 2; // the query tab
  expect(parseSnapshot(JSON.stringify(future))).toEqual(snap);
  // The active tab itself unknown: no active tab.
  future.workspaces[0].activeTabIndex = 0;
  const parsed = parseSnapshot(JSON.stringify(future));
  expect(parsed?.workspaces[0].tabs).toEqual(snap.workspaces[0].tabs);
  expect(parsed?.workspaces[0].activeTabIndex).toBeNull();
  // A tab without a kind, a known kind with a bad shape and an out-of-range index are
  // still invalid.
  const kindless = JSON.parse(JSON.stringify(future));
  kindless.workspaces[0].tabs.push({ title: "?" });
  expect(parseSnapshot(JSON.stringify(kindless))).toBeNull();
  future.workspaces[0].tabs[1].preview = "yes";
  expect(parseSnapshot(JSON.stringify(future))).toBeNull();
  future.workspaces[0].tabs[1].preview = true;
  future.workspaces[0].activeTabIndex = 5;
  expect(parseSnapshot(JSON.stringify(future))).toBeNull();
});

test("a query tab keeps the database its session was opened on through the snapshot", async () => {
  const w = workspace({
    tabs: [{ id: "t2", kind: "query", title: "Query 3", sql: "select 1", sqlSessionId: "s1", database: "old" }],
    mru: ["t2"],
  });
  const s = snapshot({ workspaces: [w], activeWorkspaceId: "w1" });
  expect(s.workspaces[0].tabs[0]).toEqual({ kind: "query", title: "Query 3", sql: "select 1", database: "old" });
  expect(parseSnapshot(JSON.stringify(s))).toEqual(s);
  // Absent (never ran) stays absent; a non-string is invalid.
  expect(snapshot({ workspaces: [workspace()], activeWorkspaceId: "w1" }).workspaces[0].tabs[1]).not.toHaveProperty(
    "database",
  );
  const bad = JSON.parse(JSON.stringify(s));
  bad.workspaces[0].tabs[0].database = 3;
  expect(parseSnapshot(JSON.stringify(bad))).toBeNull();
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(s));
  await restoreSession();
  expect(state().workspaces[0].tabs[0]).toMatchObject({ kind: "query", database: "old", sqlSessionId: null });
});

// ---- Task 4: a renamed table tab ----

test("a renamed table tab keeps its name through the snapshot (optional field)", async () => {
  const users = { schema: "public", name: "users" };
  const w = workspace({
    tabs: [
      { id: "t1", kind: "table", object: users, title: "People", preview: false },
      { id: "t2", kind: "table", object: { schema: "public", name: "orders" }, title: "orders", preview: true },
    ],
    activeTabId: "t1",
    mru: ["t1", "t2"],
  });
  const s = snapshot({ workspaces: [w], activeWorkspaceId: "w1" });
  expect(s.workspaces[0].tabs).toEqual([
    { kind: "table", object: users, preview: false, title: "People" },
    // Not renamed: the shape of earlier versions.
    { kind: "table", object: { schema: "public", name: "orders" }, preview: true },
  ]);
  expect(parseSnapshot(JSON.stringify(s))).toEqual(s);
  const bad = JSON.parse(JSON.stringify(s));
  bad.workspaces[0].tabs[0].title = 3;
  expect(parseSnapshot(JSON.stringify(bad))).toBeNull();
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(s));
  await restoreSession();
  expect(state().workspaces[0].tabs.map((t) => t.title)).toEqual(["People", "orders"]);
});
