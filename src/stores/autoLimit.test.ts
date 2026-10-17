import { beforeEach, expect, test } from "vitest";
import { autoLimitOn, autoLimitTexts, useAutoLimit } from "./autoLimit";
import { DEFAULT_SETTINGS, useSettings } from "./settings";
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

const setDefault = (autoLimitDefault: boolean, autoLimitValue = 1000) =>
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, autoLimitDefault, autoLimitValue } });

beforeEach(() => {
  useAutoLimit.setState({ override: {} });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useWorkspaces.setState({ workspaces: [ws(["t1", "t2"])], activeWorkspaceId: "w1" });
});

test("a tab follows the default until it is toggled by hand", () => {
  expect(autoLimitOn("t1")).toBe(false);
  setDefault(true);
  expect(autoLimitOn("t1")).toBe(true);
  expect(autoLimitOn("t2")).toBe(true);

  useAutoLimit.getState().setAutoLimit("t1", false);
  setDefault(false);
  setDefault(true);
  expect(autoLimitOn("t1")).toBe(false); // explicit override survives default changes
  expect(autoLimitOn("t2")).toBe(true);
});

test("an override equal to the default still pins the tab", () => {
  useAutoLimit.getState().setAutoLimit("t1", false); // same as the default (off)
  setDefault(true);
  expect(autoLimitOn("t1")).toBe(false);
});

test("overrides are forgotten when the tab closes", () => {
  useAutoLimit.getState().setAutoLimit("t1", true);
  useAutoLimit.getState().setAutoLimit("t2", false);
  expect(useAutoLimit.getState().override).toEqual({ t1: true, t2: false });

  useWorkspaces.setState({ workspaces: [ws(["t2"])] });
  expect(useAutoLimit.getState().override).toEqual({ t2: false });
  useWorkspaces.setState({ workspaces: [ws([])] });
  expect(useAutoLimit.getState().override).toEqual({});
});

test("autoLimitTexts applies the configured value only when the tab's Auto LIMIT is on", () => {
  const stmts = [{ text: "select * from t" }, { text: "update t set a = 1" }];
  expect(autoLimitTexts("t1", stmts, "postgres")).toEqual(["select * from t", "update t set a = 1"]);
  setDefault(true, 50);
  expect(autoLimitTexts("t1", stmts, "postgres")).toEqual(["select * from t LIMIT 50", "update t set a = 1"]);
  useAutoLimit.getState().setAutoLimit("t1", false);
  expect(autoLimitTexts("t1", stmts, "postgres")).toEqual(["select * from t", "update t set a = 1"]);
});
