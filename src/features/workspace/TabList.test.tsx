import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { strings } from "../../lib/strings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { TabList } from "./TabList";

const workspace: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  database: null,
  schemas: ["public", "audit"],
  currentSchema: "public",
  tabs: [
    { id: "a", kind: "table", object: { schema: "public", name: "users" }, title: "users", preview: false },
    { id: "b", kind: "table", object: { schema: "audit", name: "events" }, title: "events", preview: true },
    { id: "c", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
  ],
  activeTabId: "a",
  mru: ["a", "b", "c"],
};

beforeEach(() => {
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
});

const openList = async () => {
  render(<TabList workspace={workspace} />);
  await userEvent.click(screen.getByRole("button", { name: strings.workspace.tabList }));
};

test("the button opens a list of all tabs with title, type and schema", async () => {
  await openList();
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(3);
  expect(options[1]).toHaveTextContent("events");
  expect(options[1]).toHaveTextContent(strings.workspace.tabKind.table);
  expect(options[1]).toHaveTextContent("audit");
  expect(options[2]).toHaveTextContent(strings.workspace.tabKind.query);
});

test("typing filters the list and Enter activates the highlighted entry", async () => {
  await openList();
  await userEvent.type(screen.getByRole("searchbox", { name: strings.workspace.tabListFilter }), "aud");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("b");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("arrow keys move the highlight and clicking an entry activates it", async () => {
  await openList();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("c");
  await userEvent.click(screen.getByRole("button", { name: strings.workspace.tabList }));
  await userEvent.click(screen.getByRole("option", { name: /events/ }));
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("b");
});

test("Escape closes the list without activating; no match shows a message", async () => {
  await openList();
  await userEvent.type(screen.getByRole("searchbox"), "zzz");
  expect(screen.queryByRole("option")).toBeNull();
  expect(screen.getByText(strings.workspace.tabListEmpty)).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("a");
});
