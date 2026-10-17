import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import { registerPendingFlush } from "../lib/pendingFlush";
import type { ConnectionConfig } from "../lib/types";
import { onFlushRequested } from "../lib/windowClose";
import { useConnections } from "./connections";
import { restoreSession, startSessionAutosave } from "./session";
import { type Workspace, useWorkspaces } from "./workspaces";

vi.mock("../lib/ipc");
vi.mock("../lib/windowClose");

const cfg: ConnectionConfig = {
  id: "c1",
  name: "Conn",
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
};

const workspace = (): Workspace => ({
  id: "w1",
  connectionId: "c1",
  name: "Conn",
  color: "swatch-2",
  envTag: "staging",
  dialect: "postgres",
  status: "connected",
  database: "app",
  schemas: ["public"],
  currentSchema: "public",
  tabs: [{ id: "t1", kind: "query", title: "Query 1", sql: "select 1", sqlSessionId: null }],
  activeTabId: "t1",
  mru: ["t1"],
});

let requestFlush: () => void;
let calls: string[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  calls = [];
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null, connectRequest: null });
  useConnections.setState({ items: [cfg] });
  vi.mocked(ipc.sessionLoad).mockResolvedValue(null);
  vi.mocked(ipc.sessionSave).mockImplementation(async () => {
    calls.push("save");
  });
  vi.mocked(ipc.windowCloseConfirmed).mockImplementation(async () => {
    calls.push("close");
  });
  vi.mocked(onFlushRequested).mockImplementation(async (h) => {
    requestFlush = h;
    return () => {};
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const flushRequested = async () => {
  requestFlush();
  await vi.advanceTimersByTimeAsync(0);
};
const savedJson = () => JSON.parse(vi.mocked(ipc.sessionSave).mock.calls[0][0]);

test("a change made 100 ms before the close is saved, then the window is closed", async () => {
  const stop = startSessionAutosave();
  await restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await vi.advanceTimersByTimeAsync(100);
  await flushRequested();
  expect(calls).toEqual(["save", "close"]);
  expect(savedJson().workspaces[0].tabs[0].sql).toBe("select 1");
  // The pending 1 s timer must not save a second time.
  await vi.advanceTimersByTimeAsync(5000);
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  stop();
});

test("a pending editor debounce is flushed into the store before the save", async () => {
  const stop = startSessionAutosave();
  await restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await vi.advanceTimersByTimeAsync(2000);
  vi.mocked(ipc.sessionSave).mockClear();
  calls.length = 0;
  const unregister = registerPendingFlush(() =>
    useWorkspaces.getState().updateTab("w1", "t1", { sql: "select typed" }),
  );
  await flushRequested();
  expect(calls).toEqual(["save", "close"]);
  expect(savedJson().workspaces[0].tabs[0].sql).toBe("select typed");
  unregister();
  stop();
});

test("the window is still closed when the save fails", async () => {
  vi.mocked(ipc.sessionSave).mockRejectedValue({ kind: "io", message: "disk" });
  const stop = startSessionAutosave();
  await restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await flushRequested();
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  expect(ipc.windowCloseConfirmed).toHaveBeenCalledTimes(1);
  stop();
});

test("nothing to save: the window is closed without a write", async () => {
  const stop = startSessionAutosave();
  await restoreSession();
  await flushRequested();
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  expect(ipc.windowCloseConfirmed).toHaveBeenCalledTimes(1);
  stop();
});

test("a corrupt session with no user change is not overwritten on close", async () => {
  vi.mocked(ipc.sessionLoad).mockResolvedValue("{not json");
  const stop = startSessionAutosave();
  await restoreSession();
  await flushRequested();
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  expect(ipc.windowCloseConfirmed).toHaveBeenCalledTimes(1);
  stop();
});

test("a close requested before the restore finished saves nothing but still closes", async () => {
  let finish!: (v: string | null) => void;
  vi.mocked(ipc.sessionLoad).mockReturnValue(new Promise((r) => (finish = r)));
  const stop = startSessionAutosave();
  const restoring = restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await flushRequested();
  expect(ipc.sessionSave).not.toHaveBeenCalled();
  expect(ipc.windowCloseConfirmed).toHaveBeenCalledTimes(1);
  finish(null);
  await restoring;
  stop();
});

test("beforeunload after the close flush does not save again", async () => {
  const stop = startSessionAutosave();
  await restoreSession();
  useWorkspaces.setState({ workspaces: [workspace()], activeWorkspaceId: "w1" });
  await flushRequested();
  window.dispatchEvent(new Event("beforeunload"));
  expect(ipc.sessionSave).toHaveBeenCalledTimes(1);
  stop();
});
