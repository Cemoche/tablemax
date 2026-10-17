import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import { useGridViews } from "./gridViews";
import { useWorkspaces } from "./workspaces";

vi.mock("../lib/ipc");

beforeEach(() => useGridViews.setState({ views: {} }));

test("views default, patch and drop", () => {
  const v = useGridViews.getState();
  expect(v.getView("t1")).toEqual({ page: 0, sort: null });
  v.setView("t1", { page: 3 });
  v.setView("t1", { sort: ["id", "desc"] });
  expect(useGridViews.getState().getView("t1")).toEqual({ page: 3, sort: ["id", "desc"] });
  expect(useGridViews.getState().getView("t2").page).toBe(0);
  useGridViews.getState().dropView("t1");
  expect(useGridViews.getState().getView("t1")).toEqual({ page: 0, sort: null });
});

test("closing a table tab drops its view", () => {
  vi.mocked(ipc.sqlSessionClose).mockResolvedValue(undefined);
  useWorkspaces.setState({
    workspaces: [
      {
        id: "w1",
        connectionId: "c1",
        name: "PG",
        color: "swatch-1",
        envTag: "local",
        dialect: "postgres",
        schemas: ["public"],
        currentSchema: "public",
        tabs: [{ id: "t1", kind: "table", object: { schema: "public", name: "u" }, title: "u", preview: false }],
        activeTabId: "t1",
        mru: [],
      },
    ],
    activeWorkspaceId: "w1",
  });
  useGridViews.getState().setView("t1", { page: 2 });
  useWorkspaces.getState().closeTab("w1", "t1");
  expect(useGridViews.getState().views).not.toHaveProperty("t1");
});
