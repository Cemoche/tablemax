import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { ObjectSidebar } from "./ObjectSidebar";

vi.mock("../../lib/ipc");

const workspace: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  schemas: ["public", "audit"],
  currentSchema: "public",
  tabs: [],
  activeTabId: null,
  mru: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
  vi.mocked(ipc.objectsList).mockResolvedValue([
    { schema: "public", name: "Accounts", kind: "table" },
    { schema: "public", name: "users", kind: "table" },
    { schema: "public", name: "active_users", kind: "view" },
    { schema: "public", name: "orders", kind: "table" },
  ]);
});

test("sidebar filter is case-insensitive and keeps tables before views", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await screen.findByRole("button", { name: /Accounts/ });
  expect(ipc.objectsList).toHaveBeenCalledWith("w1", "public");
  await userEvent.type(screen.getByRole("searchbox"), "USER");
  const items = screen.getAllByRole("button", { name: /users/i }).map((b) => b.textContent);
  expect(items[0]).toContain("users");
  expect(items[1]).toContain("active_users");
  expect(screen.queryByRole("button", { name: /orders/ })).toBeNull();
});

test("clicking an object opens a table tab", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  await userEvent.click(await screen.findByRole("button", { name: /orders/ }));
  await waitFor(() => expect(useWorkspaces.getState().workspaces[0].tabs).toHaveLength(1));
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({
    kind: "table",
    title: "orders",
  });
});

test("single click opens a preview tab, double click pins it", async () => {
  render(<ObjectSidebar workspace={workspace} />);
  const orders = await screen.findByRole("button", { name: /orders/ });
  await userEvent.click(orders);
  expect(useWorkspaces.getState().workspaces[0].tabs[0]).toMatchObject({ preview: true });
  await userEvent.dblClick(orders);
  const tabs = useWorkspaces.getState().workspaces[0].tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ preview: false });
});
