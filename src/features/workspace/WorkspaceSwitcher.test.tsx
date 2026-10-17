import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

vi.mock("../../lib/ipc");

// Node's process (vitest runs on Node); typed locally since the app has no @types/node.
type Listener = (reason: unknown) => void;
const proc = (globalThis as unknown as {
  process: { on(e: string, f: Listener): void; off(e: string, f: Listener): void };
}).process;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  vi.resetAllMocks();
  unhandled.length = 0;
  proc.on("unhandledRejection", onUnhandled);
  useWorkspaces.setState({
    workspaces: [
      {
        id: "w1",
        connectionId: "c1",
        name: "Local PG",
        color: "swatch-1",
        envTag: "dev",
        dialect: "postgres",
        status: "connected",
        database: null,
        schemas: [],
        currentSchema: null,
        tabs: [],
        activeTabId: null,
        mru: [],
      } satisfies Workspace,
    ],
    activeWorkspaceId: "w1",
  });
});

afterEach(() => {
  proc.off("unhandledRejection", onUnhandled);
});

test("closing a workspace whose backend close fails leaves no unhandled rejection", async () => {
  vi.mocked(ipc.workspaceClose).mockRejectedValue({ kind: "connectionLost", message: "gone" });
  render(
    <WorkspaceSwitcher connectionsActive={false} onShowConnections={vi.fn()} onSelectWorkspace={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Close workspace Local PG" }));
  expect(ipc.workspaceClose).toHaveBeenCalledWith("w1");
  // Let the rejection settle and Node report it if nobody handled it.
  await new Promise((r) => setTimeout(r, 10));
  expect(unhandled).toEqual([]);
  expect(useWorkspaces.getState().workspaces).toEqual([]);
});

test("a workspace with a running commit cannot be closed yet", () => {
  const ws = useWorkspaces.getState().workspaces[0];
  useWorkspaces.setState({
    workspaces: [{ ...ws, tabs: [{ id: "t1", kind: "table", object: { schema: null, name: "x" }, title: "x", preview: false }] }],
  });
  usePendingChanges.setState({ committing: { t1: true } });
  render(<WorkspaceSwitcher connectionsActive={false} onShowConnections={() => {}} onSelectWorkspace={() => {}} />);
  const close = screen.getByRole("button", { name: strings.workspace.closeWorkspace("Local PG") });
  expect(close).toBeDisabled();
  expect(close).toHaveAttribute("title", strings.grid.closeWhileCommitting);
  usePendingChanges.setState({ committing: {} });
});
