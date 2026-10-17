import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
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
const View = () => <WorkspaceView workspace={useWorkspaces((s) => s.workspaces[0])} />;

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [base], activeWorkspaceId: "w1", closeRequest: null });
  usePendingChanges.setState({ tabs: {}, blocked: {}, committing: {}, applied: {} });
  vi.mocked(ipc.changesApply).mockResolvedValue({
    applied: true,
    affected: [1],
    failedIndex: null,
    error: null,
  });
});

test("Ctrl+S commits the pending changes of the active table tab", async () => {
  usePendingChanges.getState().addInsert("t1");
  render(<View />);
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(() =>
    expect(ipc.changesApply).toHaveBeenCalledWith("w1", object, [{ kind: "insert", values: [] }]),
  );
  await waitFor(() => expect(usePendingChanges.getState().count("t1")).toBe(0));
});

test("Ctrl+S does nothing in a query tab or while a modal is open", async () => {
  usePendingChanges.getState().addInsert("t1");
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
  usePendingChanges.getState().addInsert("t1");
  usePendingChanges.getState().addInsert("t1");
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
