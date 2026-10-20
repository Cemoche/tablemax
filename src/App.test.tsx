import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  capabilities: {
    sqlEditor: true,
    gridEditing: true,
    routines: true,
    ddl: true,
    foreignKeys: true,
    documents: false,
    databaseSwitch: true,
  },
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
  vi.mocked(ipc.routinesList).mockResolvedValue([]);
  vi.mocked(ipc.databasesList).mockResolvedValue([]);
  vi.mocked(ipc.workspaceClose).mockResolvedValue(undefined);
  vi.mocked(ipc.appVersion).mockResolvedValue("1.2.3");
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

test("selecting a disconnected workspace in the connections column connects it", async () => {
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
  await user.click(screen.getByRole("button", { name: strings.connectionsColumn.close("Prod PG") }));
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
    expect(screen.queryByRole("navigation", { name: strings.connectionsColumn.label })).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(useWorkspaces.getState().workspaces).toEqual([]);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(ipc.sessionSave).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

/** The connection's row in the connection list (not its workspace button in the column). */
const listRow = (name: string) => screen.getByRole("option", { name });

test("a restored connection reopened from the connection list shows why it failed", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  await user.click(screen.getByRole("button", { name: strings.connectionsColumn.connections }));
  vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce({ kind: "connection", message: "connection refused" });
  await user.dblClick(listRow("Prod PG"));
  expect(await screen.findByText("connection refused")).toBeInTheDocument();
  expect(useWorkspaces.getState().workspaces[0].status).toBe("disconnected");
});

test("a changed SSH host key on a restored connection opened from the list is shown", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  await user.click(screen.getByRole("button", { name: strings.connectionsColumn.connections }));
  vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce({
    kind: "hostKeyChanged",
    message: "SHA256:evil",
    host: "bastion:22",
  });
  await user.dblClick(listRow("Prod PG"));
  expect(
    await screen.findByText(strings.ssh.hostKeyChanged("SHA256:evil", "bastion:22")),
  ).toBeInTheDocument();
});

test("prod_title_kept: no environment banner, the pill badge and the window title say PROD", async () => {
  vi.mocked(ipc.windowSetTitle).mockResolvedValue(undefined);
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  expect(ipc.windowSetTitle).toHaveBeenLastCalledWith("TableMax — Prod PG [PROD]");
  const header = screen.getByRole("banner");
  expect(within(header).getByText(strings.statusPill.tags.prod)).toBeInTheDocument();
  // The old banner is gone.
  expect(screen.queryByRole("status", { name: "Environment" })).toBeNull();
});

test("Ctrl+Shift+K shows the connection list from a workspace, its search focused", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
  expect(await screen.findByRole("option", { name: "Prod PG" })).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: strings.connections.searchLabel })).toHaveFocus();
  expect(screen.getByRole("region", { name: strings.connections.welcomeLabel })).toBeInTheDocument();
});

test("the palette's Show connections shows the connection list from a workspace (#119)", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("tab", { name: "users" });
  await user.keyboard("{Control>}p{/Control}");
  const dialog = await screen.findByRole("dialog", { name: strings.palette.label });
  await user.type(within(dialog).getByRole("combobox"), ">show connections");
  await user.click(within(dialog).getByText(strings.palette.action.showConnections));
  expect(await screen.findByRole("option", { name: "Prod PG" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("searchbox", { name: strings.connections.searchLabel })).toHaveFocus());
});

test("Ctrl+N opens a new connection's form; its back button returns to the list", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.sessionLoad).mockResolvedValue(null);
  render(<App />);
  await screen.findByRole("option", { name: "Prod PG" });
  await user.keyboard("{Control>}n{/Control}");
  expect(screen.getByRole("heading", { name: strings.form.newTitle })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Prod PG" })).toBeNull();
  await user.click(screen.getByRole("button", { name: strings.connections.back }));
  expect(screen.getByRole("option", { name: "Prod PG" })).toBeInTheDocument();
});

test("the row menu's Edit… opens the connection's form; Create connection… a new one", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.sessionLoad).mockResolvedValue(null);
  render(<App />);
  const row = await screen.findByRole("option", { name: "Prod PG" });
  row.focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  await user.click(screen.getByRole("menuitem", { name: strings.connections.edit }));
  expect(screen.getByRole("heading", { name: strings.form.editTitle })).toBeInTheDocument();
  expect(screen.getByLabelText(strings.form.name)).toHaveValue("Prod PG");
  await user.click(screen.getByRole("button", { name: strings.connections.back }));
  await user.click(screen.getByRole("button", { name: strings.connections.create }));
  expect(screen.getByRole("heading", { name: strings.form.newTitle })).toBeInTheDocument();
});

describe("unsaved edits in the connection form are never dropped silently", () => {
  const dev = cfg({ id: "c2", name: "Dev PG", envTag: "dev" });
  const discardDialog = () => screen.queryByRole("dialog", { name: strings.connections.discardTitle });
  const editRow = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    screen.getByRole("option", { name }).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(screen.getByRole("menuitem", { name: strings.connections.edit }));
  };
  const nameField = () => screen.getByLabelText(strings.form.name) as HTMLInputElement;

  beforeEach(() => {
    vi.mocked(ipc.connectionsList).mockResolvedValue([cfg(), dev]);
    vi.mocked(ipc.sessionLoad).mockResolvedValue(null);
  });

  test("clean: back, Ctrl+N and Ctrl+Shift+K go at once; the focus lands on the row, Driver, the search", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("option", { name: "Dev PG" });
    await editRow(user, "Dev PG");
    expect(nameField()).toHaveFocus();
    await user.click(screen.getByRole("button", { name: strings.connections.back }));
    expect(discardDialog()).toBeNull();
    expect(screen.getByRole("option", { name: "Dev PG" })).toHaveFocus();
    await user.keyboard("{Control>}n{/Control}");
    expect(screen.getByRole("heading", { name: strings.form.newTitle })).toBeInTheDocument();
    expect(screen.getByLabelText(strings.form.driver)).toHaveFocus();
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(discardDialog()).toBeNull();
    expect(screen.getByRole("searchbox", { name: strings.connections.searchLabel })).toHaveFocus();
  });

  test("back with no row selected puts the focus in the search", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("option", { name: "Dev PG" });
    await user.click(screen.getByRole("button", { name: strings.connections.create }));
    await user.click(screen.getByRole("button", { name: strings.connections.back }));
    expect(screen.getByRole("searchbox", { name: strings.connections.searchLabel })).toHaveFocus();
  });

  test("Ctrl+Shift+K with the list already shown focuses its search at once", async () => {
    const user = userEvent.setup();
    render(<App />);
    const row = await screen.findByRole("option", { name: "Dev PG" });
    row.focus();
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(screen.getByRole("searchbox", { name: strings.connections.searchLabel })).toHaveFocus();
  });

  test("dirty: back and Ctrl+Shift+K ask; Cancel keeps the edits, Discard drops them", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("option", { name: "Dev PG" });
    await editRow(user, "Dev PG");
    await user.type(nameField(), " 2");
    const back = screen.getByRole("button", { name: strings.connections.back });
    await user.click(back);
    const ask = discardDialog() as HTMLElement;
    expect(within(ask).getByText(strings.connections.discardMessage("Dev PG"))).toBeInTheDocument();
    await user.click(within(ask).getByRole("button", { name: strings.connections.discardCancel }));
    expect(discardDialog()).toBeNull();
    expect(nameField()).toHaveValue("Dev PG 2");
    expect(back).toHaveFocus();
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    await user.click(within(discardDialog() as HTMLElement).getByRole("button", { name: strings.connections.discardOk }));
    expect(screen.getByRole("option", { name: "Dev PG" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: strings.connections.searchLabel })).toHaveFocus();
    expect(ipc.connectionSave).not.toHaveBeenCalled();
  });

  test("dirty: Ctrl+N and the palette's New connection ask before replacing the form", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("option", { name: "Dev PG" });
    await editRow(user, "Dev PG");
    await user.type(nameField(), " 2");
    await user.keyboard("{Control>}n{/Control}");
    await user.click(within(discardDialog() as HTMLElement).getByRole("button", { name: strings.connections.discardCancel }));
    expect(nameField()).toHaveValue("Dev PG 2");
    await user.keyboard("{Control>}p{/Control}");
    await user.type(within(await screen.findByRole("dialog", { name: strings.palette.label })).getByRole("combobox"), ">");
    await user.click(await screen.findByText(strings.palette.action.newConnection));
    await user.click(within(await screen.findByRole("dialog", { name: strings.connections.discardTitle })).getByRole("button", { name: strings.connections.discardOk }));
    expect(screen.getByRole("heading", { name: strings.form.newTitle })).toBeInTheDocument();
    expect(nameField()).toHaveValue("");
  });

  test("a Test prompt arriving behind a workspace leaves the shortcuts working and shows on return", async () => {
    vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(session));
    let failTest: (e: unknown) => void = () => {};
    vi.mocked(ipc.connectionTest).mockReturnValueOnce(new Promise((_, reject) => (failTest = reject)));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("tab", { name: "users" });
    await user.click(screen.getByRole("button", { name: strings.connectionsColumn.connections }));
    await editRow(user, "Dev PG");
    await user.type(nameField(), " 2");
    await user.click(screen.getByRole("button", { name: "Test" }));
    // Off to the workspace while Test runs; then the host key prompt comes in.
    vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce({ kind: "connection", message: "connection refused" });
    await user.click(screen.getByRole("button", { name: "Prod PG" }));
    await screen.findByRole("tab", { name: "users" });
    await act(async () => failTest({ kind: "hostKeyUnknown", message: "SHA256:abc", host: "bastion:22" }));
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    // Shortcuts still act: Ctrl+Shift+K asks about the form's edits.
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    await user.click(within(discardDialog() as HTMLElement).getByRole("button", { name: strings.connections.discardCancel }));
    // Back on the connections screen, the prompt is there.
    await user.click(screen.getByRole("button", { name: strings.connectionsColumn.connections }));
    expect(screen.getByRole("dialog", { name: strings.ssh.unknownHostTitle })).toBeInTheDocument();
    expect(nameField()).toHaveValue("Dev PG 2");
  });

  test("the pill's Edit: at once when clean, after Discard when the open form has edits", async () => {
    vi.mocked(ipc.sessionLoad).mockResolvedValue(JSON.stringify(session));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("tab", { name: "users" });
    const pillEdit = async () => {
      await user.click(within(screen.getByRole("banner")).getByRole("button", { name: /^PROD \|/ }));
      await user.click(screen.getByRole("button", { name: strings.connectionPopover.edit }));
    };
    // Clean: the connection's form at once.
    await pillEdit();
    expect(discardDialog()).toBeNull();
    expect(nameField()).toHaveValue("Prod PG");
    // Dirty form of another connection, left for the workspace (it stays, hidden).
    await user.click(screen.getByRole("button", { name: strings.connections.back }));
    await editRow(user, "Dev PG");
    await user.type(nameField(), " 2");
    vi.mocked(ipc.workspaceOpen).mockRejectedValueOnce({ kind: "connection", message: "connection refused" });
    await user.click(screen.getByRole("button", { name: "Prod PG" }));
    await screen.findByRole("tab", { name: "users" });
    // Really hidden behind the workspace: out of the accessibility tree and the tab order.
    expect(nameField().closest("main")).toHaveAttribute("hidden");
    expect(screen.queryByRole("textbox", { name: strings.form.name })).toBeNull();
    await pillEdit();
    await user.click(within(discardDialog() as HTMLElement).getByRole("button", { name: strings.connections.discardCancel }));
    // Cancel: still in the workspace; the edits wait on the connections screen.
    expect(screen.getByRole("tab", { name: "users" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: strings.connectionsColumn.connections }));
    expect(nameField()).toHaveValue("Dev PG 2");
    await user.click(screen.getByRole("button", { name: "Prod PG" }));
    await screen.findByRole("tab", { name: "users" });
    await pillEdit();
    await user.click(within(discardDialog() as HTMLElement).getByRole("button", { name: strings.connections.discardOk }));
    expect(nameField()).toHaveValue("Prod PG");
  });
});
