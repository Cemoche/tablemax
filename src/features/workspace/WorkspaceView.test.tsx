import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { WorkspaceView } from "./WorkspaceView";

vi.mock("../../lib/ipc");
vi.mock("./ObjectSidebar", () => ({ ObjectSidebar: () => null }));
vi.mock("../editor/QueryTab", () => ({ QueryTab: () => null }));
vi.mock("../grid/TableDataTab", () => ({ TableDataTab: () => null }));

const workspace: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  database: null,
  schemas: ["public"],
  currentSchema: "public",
  tabs: [{ id: "a", kind: "query", title: "Query 1", sql: "", sqlSessionId: null }],
  activeTabId: "a",
  mru: ["a"],
};
const tabs = () => useWorkspaces.getState().workspaces[0].tabs;
const press = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, ...init }),
    );
  });

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
  render(<WorkspaceView workspace={workspace} />);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

test("Mod+T opens a query tab and Mod+W closes the active tab", () => {
  press({ code: "KeyT" });
  expect(tabs()).toHaveLength(2);
  press({ code: "KeyW" });
  expect(tabs()).toHaveLength(1);
});

test("neither fires on repeat", () => {
  press({ code: "KeyT", repeat: true });
  press({ code: "KeyW", repeat: true });
  expect(tabs()).toHaveLength(1);
});

test("neither fires while a modal is open", () => {
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.appendChild(modal);
  press({ code: "KeyT" });
  press({ code: "KeyW" });
  expect(tabs()).toHaveLength(1);
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe("a");
});
