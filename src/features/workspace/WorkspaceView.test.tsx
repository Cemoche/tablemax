import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { CloseConfirm } from "./CloseConfirm";
import { WorkspaceView } from "./WorkspaceView";

vi.mock("../../lib/ipc");
vi.mock("./ObjectSidebar", () => ({ ObjectSidebar: () => <div /> }));
vi.mock("../grid/TableDataTab", () => ({ TableDataTab: () => <div data-testid="table-tab" /> }));
vi.mock("../editor/QueryTab", () => ({ QueryTab: () => <div data-testid="query-tab" /> }));

const object = { schema: "public", name: "users" };
const base: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "dev",
  dialect: "postgres",
  schemas: ["public"],
  currentSchema: "public",
  tabs: [
    { id: "t1", kind: "table", object, title: "users" },
    { id: "q1", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
  ],
  activeTabId: "t1",
};
const current = () => useWorkspaces.getState().workspaces[0];
const View = () => {
  const ws = useWorkspaces((s) => s.workspaces[0]);
  return (
    <>
      {ws && <WorkspaceView workspace={ws} />}
      <CloseConfirm />
    </>
  );
};

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [base], activeWorkspaceId: "w1", closeRequest: null });
  usePendingChanges.setState({
    tabs: {},
    blocked: {},
    committing: {},
    committingIn: {},
    confirming: {},
    applied: {},
    editorOpen: {},
    awaitingReload: {},
    epoch: {},
  });
  vi.mocked(ipc.changesApply).mockResolvedValue({
    applied: true,
    affected: [1],
    failedIndex: null,
    error: null,
  });
});

test("Ctrl+S commits the pending changes of the active table tab", async () => {
  usePendingChanges.getState().addInsert("t1", object);
  render(<View />);
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(() =>
    expect(ipc.changesApply).toHaveBeenCalledWith("w1", object, [{ kind: "insert", values: [] }], false),
  );
  await waitFor(() => expect(usePendingChanges.getState().count("t1")).toBe(0));
});

test("Ctrl+S on a protected connection asks for confirmation instead of committing", async () => {
  vi.mocked(ipc.changesApply).mockReset();
  vi.mocked(ipc.changesApply).mockRejectedValueOnce({ kind: "confirmationRequired", message: "0" });
  vi.mocked(ipc.changesPreview).mockResolvedValue(["INSERT INTO users DEFAULT VALUES"]);
  usePendingChanges.getState().addInsert("t1", object);
  render(<View />);
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(usePendingChanges.getState().confirming.t1).toBeDefined());
  expect(usePendingChanges.getState().confirming.t1.statements).toEqual(["INSERT INTO users DEFAULT VALUES"]);
  expect(ipc.changesApply).toHaveBeenCalledTimes(1);
  expect(usePendingChanges.getState().count("t1")).toBe(1);
});

test("Ctrl+S does nothing in a query tab or while a modal is open", async () => {
  usePendingChanges.getState().addInsert("t1", object);
  render(<View />);
  // The close confirmation is a modal.
  await userEvent.keyboard("{Control>}w{/Control}");
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await userEvent.keyboard("{Control>}s{/Control}");
  expect(ipc.changesApply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: strings.grid.discardCancel }));
  useWorkspaces.getState().activateTab("w1", "q1");
  await userEvent.keyboard("{Control>}s{/Control}");
  expect(ipc.changesApply).not.toHaveBeenCalled();
});

test("closing a tab with pending changes asks to discard them", async () => {
  usePendingChanges.getState().addInsert("t1", object);
  usePendingChanges.getState().addInsert("t1", object);
  render(<View />);
  await userEvent.click(screen.getByRole("button", { name: strings.workspace.closeTab("users") }));
  const dialog = await screen.findByRole("dialog", { name: strings.grid.discardTitle });
  expect(dialog).toHaveTextContent(strings.grid.discardConfirm(2));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.discardCancel }));
  expect(current().tabs).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: strings.workspace.closeTab("users") }));
  await userEvent.click(await screen.findByRole("button", { name: strings.grid.discardOk }));
  expect(current().tabs.map((t) => t.id)).toEqual(["q1"]);
  expect(usePendingChanges.getState().count("t1")).toBe(0);
});

test("Ctrl+S does nothing while the grid's cell editor is open", async () => {
  usePendingChanges.getState().addInsert("t1", object);
  usePendingChanges.getState().setEditorOpen("t1", true);
  render(<View />);
  await userEvent.keyboard("{Control>}s{/Control}");
  expect(ipc.changesApply).not.toHaveBeenCalled();
  usePendingChanges.getState().setEditorOpen("t1", false);
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(ipc.changesApply).toHaveBeenCalledOnce());
});

test("closing the workspace with pending changes asks with the tab count", async () => {
  vi.mocked(ipc.workspaceClose).mockResolvedValue(undefined);
  usePendingChanges.getState().addInsert("t1", object);
  render(<View />);
  void useWorkspaces.getState().closeWorkspace("w1");
  const dialog = await screen.findByRole("dialog", { name: strings.grid.discardTitle });
  expect(dialog).toHaveTextContent(strings.grid.discardConfirmWorkspace(1, 1));
  await userEvent.click(screen.getByRole("button", { name: strings.grid.discardOk }));
  await waitFor(() => expect(useWorkspaces.getState().workspaces).toHaveLength(0));
  expect(ipc.workspaceClose).toHaveBeenCalledWith("w1");
});

test("while a commit runs the tab's close button waits (Committing…)", async () => {
  usePendingChanges.getState().addInsert("t1", object);
  usePendingChanges.setState({ committing: { t1: true } });
  render(<View />);
  const close = screen.getByRole("button", { name: strings.workspace.closeTab("users") });
  expect(close).toBeDisabled();
  expect(close).toHaveAttribute("title", strings.grid.closeWhileCommitting);
  await userEvent.keyboard("{Control>}w{/Control}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(current().tabs).toHaveLength(2);
});
