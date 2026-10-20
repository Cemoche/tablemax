import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import type { Filter, ObjectRef, RowKey } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { type GridView, useGridViews } from "../../stores/gridViews";
import { usePendingChanges } from "../../stores/pendingChanges";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { useNavigationShortcuts } from "../workspace/navigation";
import { Breadcrumb } from "./Breadcrumb";

vi.mock("../../lib/ipc");

const orders: ObjectRef = { schema: "public", name: "orders" };
const lines: ObjectRef = { schema: "public", name: "order_lines" };
const customers: ObjectRef = { schema: "public", name: "customers" };
const eq = (column: string, v: string): Filter => ({ column, op: "eq", values: [v] });
const ordersView: GridView = { page: 2, sort: ["total", "desc"], filters: [eq("status", "paid")] };
const linesView: GridView = { page: 0, sort: null, filters: [eq("order_id", "7"), eq("line", "2")], combine: "or" };

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useChrome.setState({ tableViews: {} });
  usePendingChanges.setState({
    tabs: {},
    blocked: {},
    committing: {},
    committingIn: {},
    confirming: {},
    applied: {},
    editorOpen: {},
    awaitingReload: {},
    epoch: {},
  });
  useWorkspaces.setState({
    workspaces: [
      {
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
        tabs: [{ id: "t1", kind: "table", object: customers, title: "customers", preview: false }],
        activeTabId: "t1",
        mru: ["t1"],
      },
    ],
    activeWorkspaceId: "w1",
  });
  useGridViews.setState({
    views: { t1: { page: 0, sort: null, filters: [eq("id", "42")] } },
    trails: {
      t1: [
        { object: orders, view: ordersView },
        { object: lines, view: linesView },
      ],
    },
  });
});

/**
 * The breadcrumb of tab t1, following the tab's object and view like the table tab does,
 * with the workspace's Back / Forward keys (Alt+← goes back along the trail first).
 */
function Harness() {
  const tab = useWorkspaces((s) => s.workspaces[0].tabs[0]);
  const view = useGridViews((s) => s.views.t1);
  useNavigationShortcuts("w1", true);
  if (tab.kind !== "table") return null;
  return <Breadcrumb workspaceId="w1" tabId="t1" object={tab.object} filters={view?.filters ?? []} />;
}

const tab = () => useWorkspaces.getState().workspaces[0].tabs[0];

test("shows the trail then the current table with its filter", () => {
  render(<Harness />);
  const nav = screen.getByRole("navigation", { name: strings.grid.trail.label });
  // A view whose filters are joined by OR reads with OR.
  expect(nav).toHaveTextContent(
    "orders (status = paid)›order_lines (order_id = 7 OR line = 2)›customers (id = 42)",
  );
  expect(screen.getByText(strings.grid.trail.crumb("customers", "id = 42"))).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("clicking the first item restores its object, filters, sort and page", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.trail.crumb("orders", "status = paid") }));
  expect(tab()).toMatchObject({ object: orders, title: "orders" });
  expect(useGridViews.getState().getView("t1")).toEqual(ordersView);
  expect(useGridViews.getState().getTrail("t1")).toEqual([]);
  expect(screen.queryByRole("navigation")).toBeNull();
});

test("the trail's tooltip names the effective Back shortcut", () => {
  const { unmount } = render(<Harness />);
  const nav = () => screen.getByRole("navigation", { name: strings.grid.trail.label });
  expect(nav()).toHaveAttribute("data-tooltip", strings.grid.trail.back);
  expect(nav()).toHaveAttribute("data-tooltip-key", "Alt+←");
  unmount();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "nav.back": "Alt+Backspace" } } });
  render(<Harness />);
  expect(nav()).toHaveAttribute("data-tooltip-key", "Alt+Backspace");
});

test("Alt+← goes back one step", async () => {
  render(<Harness />);
  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  expect(tab()).toMatchObject({ object: lines, title: "order_lines" });
  expect(useGridViews.getState().getView("t1")).toEqual(linesView);
  expect(useGridViews.getState().getTrail("t1")).toEqual([{ object: orders, view: ordersView }]);
});

test("a custom Back combination goes back and Alt+← no longer does", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "nav.back": "Alt+Backspace" } } });
  render(<Harness />);
  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  expect(tab()).toMatchObject({ object: customers });
  await userEvent.keyboard("{Alt>}{Backspace}{/Alt}");
  expect(tab()).toMatchObject({ object: lines });
});

test("Alt+← in a text field moves the caret, it does not go back", async () => {
  render(
    <>
      <input aria-label="field" />
      <Harness />
    </>,
  );
  await userEvent.click(screen.getByRole("textbox", { name: "field" }));
  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  expect(tab()).toMatchObject({ object: customers });
});

test("with an empty trail Alt+← leaves the table alone (nothing earlier in the history)", () => {
  useGridViews.setState({ trails: {} });
  render(<Harness />);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowLeft", key: "ArrowLeft", altKey: true, cancelable: true }));
  });
  expect(tab()).toMatchObject({ object: customers });
});

test("Alt+← on the structure view goes back in the tab history, not along the trail", () => {
  useChrome.setState({ tableViews: { t1: "structure" } });
  render(<Harness />);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowLeft", key: "ArrowLeft", altKey: true, cancelable: true }));
  });
  expect(tab()).toMatchObject({ object: customers });
  expect(useGridViews.getState().getTrail("t1")).toHaveLength(2);
});

test("a held Alt+← goes back once; its repeats are prevented", () => {
  render(<Harness />);
  const hold = (repeat: boolean) => {
    const e = new KeyboardEvent("keydown", { code: "ArrowLeft", key: "ArrowLeft", altKey: true, repeat, cancelable: true });
    act(() => {
      window.dispatchEvent(e);
    });
    return e;
  };
  expect(hold(false).defaultPrevented).toBe(true);
  expect(hold(true).defaultPrevented).toBe(true);
  expect(hold(true).defaultPrevented).toBe(true);
  expect(tab()).toMatchObject({ object: lines });
  expect(useGridViews.getState().getTrail("t1")).toEqual([{ object: orders, view: ordersView }]);
});

test("going back is blocked while changes are pending", async () => {
  const key: RowKey = [["id", { t: "int", v: 42 }]];
  usePendingChanges.getState().toggleDelete("t1", customers, key);
  render(<Harness />);
  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await userEvent.click(screen.getByRole("button", { name: strings.grid.trail.crumb("orders", "status = paid") }));
  expect(tab()).toMatchObject({ object: customers });
  expect(useGridViews.getState().getTrail("t1")).toHaveLength(2);
  expect(usePendingChanges.getState().blocked.t1).toBe(true);
});

test("without a trail nothing is shown", () => {
  useGridViews.setState({ trails: {} });
  render(<Harness />);
  expect(screen.queryByRole("navigation")).toBeNull();
});
