import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import * as ipc from "./lib/ipc";
import { strings } from "./lib/strings";
import type { ConnectionConfig } from "./lib/types";
import { useConnections } from "./stores/connections";
import type { SessionSnapshot } from "./stores/session";
import { useWorkspaces } from "./stores/workspaces";

vi.mock("./lib/ipc");
vi.mock("./features/grid/TableDataTab", () => ({
  TableDataTab: ({ workspaceId }: { workspaceId: string }) => <p>{`table data in ${workspaceId}`}</p>,
}));
vi.mock("./features/editor/QueryTab", () => ({
  QueryTab: ({ workspace }: { workspace: { id: string } }) => <p>{`query editor in ${workspace.id}`}</p>,
}));

// Node's process (vitest runs on Node); typed locally since the app has no @types/node.
type Listener = (reason: unknown) => void;
const proc = (globalThis as unknown as {
  process: { on(e: string, f: Listener): void; off(e: string, f: Listener): void };
}).process;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

const cfg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "c1",
  name: "Prod PG",
  color: "swatch-1",
  envTag: "prod",
  kind: "postgres",
  host: "db.internal",
  port: 5432,
  user: "u",
  database: "app",
  sqlitePath: null,
  passwordMode: "ask",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  ...over,
});

const session: SessionSnapshot = {
  version: 1,
  activeWorkspaceIndex: 0,
  workspaces: [
    {
      connectionId: "c1",
      currentSchema: "public",
      database: "app",
      activeTabIndex: 0,
      tabs: [
        { kind: "table", object: { schema: "public", name: "users" }, preview: false },
        { kind: "query", title: "Query 1", sql: "select 1" },
      ],
    },
  ],
};

const info = {
  workspaceId: "w1",
  connectionId: "c1",
  dialect: "postgres" as const,
  serverVersion: "16",
  database: "app",
};
const passwordRequired = { kind: "auth", message: "password required" };

beforeEach(() => {
  vi.resetAllMocks();
  unhandled.length = 0;
  proc.on("unhandledRejection", onUnhandled);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null, connectRequest: null });
  useConnections.setState({ items: [] });
  vi.mocked(ipc.connectionsList).mockResolvedValue([cfg()]);
  vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(session));
  vi.mocked(ipc.sessionSave).mockResolvedValue(undefined);
  vi.mocked(ipc.schemasList).mockResolvedValue(["public"]);
  vi.mocked(ipc.objectsList).mockResolvedValue([]);
  vi.mocked(ipc.workspaceClose).mockResolvedValue(undefined);
});
afterEach(async () => {
  // Let pending promise callbacks settle before checking for unhandled rejections.
  await new Promise((r) => setTimeout(r, 0));
  proc.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

const tab = (name: string) => screen.getByRole("tab", { name });
const reconnect = () => screen.queryByRole("button", { name: strings.session.reconnect });

test("restored_workspace_connects_on_activation", async () => {
  const user = userEvent.setup();
  render(<App />);
  // Tabs come back, the restored workspace is shown disconnected, nothing connects.
  expect(await screen.findByRole("tab", { name: "users" })).toBeInTheDocument();
  expect(tab("Query 1")).toBeInTheDocument();
  expect(screen.getByText(strings.session.disconnected)).toBeInTheDocument();
  expect(reconnect()).toBeInTheDocument();
  expect(screen.queryByText(/table data/)).toBeNull();
  expect(ipc.workspaceOpen).not.toHaveBeenCalled();

  // Activating a tab runs the usual flow: the Ask password is prompted for.
  vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce(passwordRequired);
  await user.click(tab("Query 1"));
  const prompt = await screen.findByRole("dialog", { name: strings.secretPrompt.password.title });
  expect(ipc.workspaceOpen).toHaveBeenCalledWith("c1", null, null, null);

  // Cancel leaves the tabs in place with a Reconnect button.
  await user.click(within(prompt).getByRole("button", { name: strings.secretPrompt.cancel }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(reconnect()).toBeInTheDocument();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(useWorkspaces.getState().workspaces[0].status).toBe("disconnected");
  expect(ipc.workspaceOpen).toHaveBeenCalledTimes(1);

  // Reconnect asks again; the typed password connects the workspace in place.
  vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce(passwordRequired).mockResolvedValueOnce(info);
  await user.click(reconnect()!);
  const again = await screen.findByRole("dialog", { name: strings.secretPrompt.password.title });
  await user.type(within(again).getByLabelText(strings.secretPrompt.password.label), "pw");
  await user.click(within(again).getByRole("button", { name: strings.secretPrompt.ok }));
  expect(await screen.findByText("query editor in w1")).toBeInTheDocument();
  expect(ipc.workspaceOpen).toHaveBeenLastCalledWith("c1", "pw", null, null);
  expect(reconnect()).toBeNull();
  expect(useWorkspaces.getState().workspaces).toHaveLength(1);
  expect(useWorkspaces.getState().workspaces[0]).toMatchObject({ id: "w1", status: "connected" });
  // The password typed at the prompt is in no store.
  expect(JSON.stringify(useWorkspaces.getState())).not.toContain("pw\"");

  await user.click(tab("users"));
  expect(await screen.findByText("table data in w1")).toBeInTheDocument();
});

test("an SSH workspace asks to trust an unknown host key on activation; cancel keeps it", async () => {
  vi.mocked(ipc.connectionsList).mockResolvedValue([
    cfg({
      passwordMode: "keyring",
      ssh: { host: "bastion", port: 22, user: "me", auth: "password", keyFile: null, secretMode: "keyring" },
    }),
  ]);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  expect(ipc.workspaceOpen).not.toHaveBeenCalled();

  vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce({
    kind: "hostKeyUnknown",
    message: "SHA256:abc",
    host: "bastion:22",
  });
  await user.click(tab("users"));
  const prompt = await screen.findByRole("dialog", { name: strings.ssh.unknownHostTitle });
  await user.click(within(prompt).getByRole("button", { name: strings.ssh.cancel }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(reconnect()).toBeInTheDocument();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
});

test("a connect error is shown in the disconnected workspace", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce({ kind: "connection", message: "connection refused" });
  await user.click(reconnect()!);
  expect(await screen.findByText("connection refused")).toBeInTheDocument();
  expect(reconnect()).toBeInTheDocument();
});

test("selecting a disconnected workspace in the switcher connects it", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  vi.mocked(ipc.workspaceOpen).mockResolvedValueOnce(info);
  await user.click(screen.getByRole("button", { name: "Prod PG" }));
  expect(await screen.findByText("table data in w1")).toBeInTheDocument();
  expect(ipc.workspaceOpen).toHaveBeenCalledTimes(1);
});

test("closing a never-connected workspace does not call the backend", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  await user.click(screen.getByRole("button", { name: strings.workspace.closeWorkspace("Prod PG") }));
  expect(useWorkspaces.getState().workspaces).toEqual([]);
  expect(ipc.workspaceClose).not.toHaveBeenCalled();
  expect(ipc.workspaceOpen).not.toHaveBeenCalled();
});

test("corrupt_session_is_ignored at startup: empty start, the file is not overwritten", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.mocked(ipc.sessionLoad).mockResolvedValue("{\"version\":1,\"workspaces\":");
    render(<App />);
    expect(await screen.findByText("Prod PG")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: strings.workspace.switcherLabel })).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(useWorkspaces.getState().workspaces).toEqual([]);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(ipc.sessionSave).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
