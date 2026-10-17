import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import { useGridViews } from "./gridViews";
import { useWorkspaces } from "./workspaces";

vi.mock("../lib/ipc");

beforeEach(() => useGridViews.setState({ views: {}, trails: {} }));

test("views default, patch and drop", () => {
  const v = useGridViews.getState();
  expect(v.getView("t1")).toEqual({ page: 0, sort: null, filters: [] });
  v.setView("t1", { page: 3 });
  v.setView("t1", { sort: ["id", "desc"] });
  expect(useGridViews.getState().getView("t1")).toEqual({ page: 3, sort: ["id", "desc"], filters: [] });
  expect(useGridViews.getState().getView("t2").page).toBe(0);
  useGridViews.getState().dropView("t1");
  expect(useGridViews.getState().getView("t1")).toEqual({ page: 0, sort: null, filters: [] });
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
        tabs: [{ id: "t1", kind: "table", object: { schema: "public", name: "u" }, title: "u" }],
        activeTabId: "t1",
      },
    ],
    activeWorkspaceId: "w1",
  });
  useGridViews.getState().setView("t1", { page: 2 });
  useWorkspaces.getState().closeTab("w1", "t1");
  expect(useGridViews.getState().views).not.toHaveProperty("t1");
});

test("setNavigation replaces view and trail; both are dropped with the view", () => {
  const v = useGridViews.getState();
  const entry = (name: string) => ({
    object: { schema: "public", name },
    view: { page: 1, sort: null, filters: [] },
  });
  expect(v.getTrail("t1")).toEqual([]);
  v.setView("t1", { page: 4 });
  const view = { page: 0, sort: null, filters: [{ column: "id", op: "eq" as const, values: ["1"] }] };
  v.setNavigation("t1", view, [entry("a"), entry("b")]);
  expect(useGridViews.getState().getTrail("t1")).toEqual([entry("a"), entry("b")]);
  expect(useGridViews.getState().getView("t1")).toEqual(view);
  useGridViews.getState().dropView("t1");
  expect(useGridViews.getState().getTrail("t1")).toEqual([]);
  expect(useGridViews.getState().trails).not.toHaveProperty("t1");
});
