import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";
import { useConnections } from "../../stores/connections";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { OpenConnectionsColumn } from "./OpenConnectionsColumn";

vi.mock("../../lib/ipc");

const C = strings.connectionsColumn;

const ws = (id: string, name: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  connectionId: `c-${id}`,
  name,
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
  ...over,
});

const saved = (id: string, color: string): ConnectionConfig => ({
  id,
  name: "PG",
  color,
  envTag: "dev",
  kind: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "prefer", caFile: null, certFile: null, keyFile: null },
  ssh: null,
});

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
  useConnections.setState({ items: [] });
  usePendingChanges.setState({ committing: {} });
  useWorkspaces.setState({
    workspaces: [ws("w1", "Local PG"), ws("w2", "Staging MySQL", { color: "swatch-3" }), ws("w3", "Prod")],
    activeWorkspaceId: "w1",
  });
});

afterEach(() => {
  proc.off("unhandledRejection", onUnhandled);
});

/** Selecting a workspace activates it, as App does. */
const select = vi.fn((id: string) => useWorkspaces.setState({ activeWorkspaceId: id }));

const renderColumn = (connectionsActive = false, onShowConnections = vi.fn()) =>
  render(
    <OpenConnectionsColumn
      connectionsActive={connectionsActive}
      onShowConnections={onShowConnections}
      onSelectWorkspace={select}
    />,
  );

test("column_lists_open_workspaces_and_switches", async () => {
  const onShowConnections = vi.fn();
  renderColumn(false, onShowConnections);
  const nav = screen.getByRole("navigation", { name: C.label });
  const tiles = within(nav)
    .getAllByRole("button")
    .filter((b) => b.dataset.workspaceTile !== undefined);
  expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual(["Local PG", "Staging MySQL", "Prod"]);
  // The active workspace's tile is the current one.
  expect(screen.getByRole("button", { name: "Local PG" })).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: "Prod" })).not.toHaveAttribute("aria-current");
  await userEvent.click(screen.getByRole("button", { name: "Staging MySQL" }));
  expect(select).toHaveBeenCalledWith("w2");
  // The Connections button shows the connection list.
  await userEvent.click(screen.getByRole("button", { name: C.connections }));
  expect(onShowConnections).toHaveBeenCalled();
});

test("on the connections screen no tile is current and Connections is pressed", () => {
  renderColumn(true);
  expect(screen.getByRole("button", { name: C.connections })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Local PG" })).not.toHaveAttribute("aria-current");
});

test("the tile icon has the live color of the saved connection", () => {
  useConnections.setState({ items: [saved("c-w1", "swatch-5")] });
  renderColumn();
  const icon = screen.getByRole("button", { name: "Local PG" }).querySelector("[data-tile-icon]");
  expect(icon).toHaveClass("bg-swatch-5");
  // Without a saved connection, the color the workspace was opened with.
  const icon2 = screen.getByRole("button", { name: "Staging MySQL" }).querySelector("[data-tile-icon]");
  expect(icon2).toHaveClass("bg-swatch-3");
});

test("a long name is shown on two lines at most, with the full name in the tooltip", () => {
  const long = "A very long connection name that never fits in eighty pixels";
  useWorkspaces.setState({ workspaces: [ws("w1", long)], activeWorkspaceId: "w1" });
  renderColumn();
  const tile = screen.getByRole("button", { name: long });
  expect(tile).toHaveAttribute("data-tooltip", long);
  expect(tile).toHaveAttribute("data-tooltip-overflow");
  expect(within(tile).getByText(long)).toHaveClass("line-clamp-2");
});

const press = (code: string, shift = true) => fireEvent.keyDown(window, { code, ctrlKey: true, shiftKey: shift });

test("workspace_shortcuts_cycle: Ctrl+Shift+] / [ and Ctrl+Shift+PageDown / PageUp, wrapping", () => {
  renderColumn();
  press("BracketRight");
  expect(select).toHaveBeenLastCalledWith("w2");
  press("PageDown");
  expect(select).toHaveBeenLastCalledWith("w3");
  press("BracketRight");
  expect(select).toHaveBeenLastCalledWith("w1");
  press("BracketLeft");
  expect(select).toHaveBeenLastCalledWith("w3");
  press("PageUp");
  expect(select).toHaveBeenLastCalledWith("w2");
  // Without Shift it is not the workspace shortcut.
  select.mockClear();
  press("BracketRight", false);
  expect(select).not.toHaveBeenCalled();
});

test("from the connections screen, next goes to the first workspace and previous to the last", () => {
  renderColumn(true);
  press("BracketRight");
  expect(select).toHaveBeenLastCalledWith("w1");
  press("BracketLeft");
  // The store says w1 is active now, but the column still shows the connections screen.
  expect(select).toHaveBeenLastCalledWith("w3");
});

test("closing a workspace whose backend close fails leaves no unhandled rejection", async () => {
  vi.mocked(ipc.workspaceClose).mockRejectedValue({ kind: "connectionLost", message: "gone" });
  renderColumn();
  await userEvent.click(screen.getByRole("button", { name: C.close("Local PG") }));
  expect(ipc.workspaceClose).toHaveBeenCalledWith("w1");
  await new Promise((r) => setTimeout(r, 10));
  expect(unhandled).toEqual([]);
  expect(useWorkspaces.getState().workspaces.map((w) => w.id)).toEqual(["w2", "w3"]);
});

test("a workspace with a running commit cannot be closed yet", async () => {
  const w = ws("w1", "Local PG", {
    tabs: [{ id: "t1", kind: "table", object: { schema: null, name: "x" }, title: "x", preview: false }],
  });
  useWorkspaces.setState({ workspaces: [w], activeWorkspaceId: "w1" });
  usePendingChanges.setState({ committing: { t1: true } });
  renderColumn();
  const close = screen.getByRole("button", { name: C.close("Local PG") });
  // Focusable, says why (review #109), does nothing.
  expect(close).not.toBeDisabled();
  expect(close).toHaveAttribute("aria-disabled", "true");
  expect(close).toHaveAttribute("data-tooltip", strings.grid.closeWhileCommitting);
  expect(close).toHaveAccessibleDescription(strings.grid.closeWhileCommitting);
  await userEvent.click(close);
  act(() => close.focus());
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard(" ");
  expect(ipc.workspaceClose).not.toHaveBeenCalled();
  expect(useWorkspaces.getState().workspaces.map((x) => x.id)).toEqual(["w1"]);
});
