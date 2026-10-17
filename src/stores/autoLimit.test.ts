import { beforeEach, expect, test } from "vitest";
import { useAutoLimit } from "./autoLimit";
import { type Workspace, useWorkspaces } from "./workspaces";

const ws = (tabIds: string[]): Workspace => ({
  id: "w1",
  connectionId: "c1",
  name: "n",
  color: "swatch-1",
  envTag: "dev",
  dialect: "postgres",
  status: "connected",
  database: null,
  schemas: [],
  currentSchema: null,
  tabs: tabIds.map((id) => ({ id, kind: "query", title: id, sql: "", sqlSessionId: null })),
  activeTabId: tabIds[0] ?? null,
  mru: [],
});

beforeEach(() => {
  useAutoLimit.setState({ on: {} });
  useWorkspaces.setState({ workspaces: [ws(["t1", "t2"])], activeWorkspaceId: "w1" });
});

test("Auto LIMIT is per tab and forgotten when the tab closes", () => {
  useAutoLimit.getState().setAutoLimit("t1", true);
  expect(useAutoLimit.getState().on).toEqual({ t1: true });
  useAutoLimit.getState().setAutoLimit("t2", true);
  useAutoLimit.getState().setAutoLimit("t2", false);
  expect(useAutoLimit.getState().on).toEqual({ t1: true });

  useWorkspaces.setState({ workspaces: [ws(["t2"])] });
  expect(useAutoLimit.getState().on).toEqual({});
});
