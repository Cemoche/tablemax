import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import type { ObjectRef } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { useGridViews } from "../../stores/gridViews";
import { usePendingChanges } from "../../stores/pendingChanges";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { CloseConfirm } from "./CloseConfirm";
import { TabBar } from "./TabBar";

vi.mock("../../lib/ipc");

const users: ObjectRef = { schema: "public", name: "users" };
const LONG = "a_really_long_table_name_that_never_fits_in_a_capsule_of_the_tab_bar";

const base: Workspace = {
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
  tabs: [],
  activeTabId: null,
  mru: [],
};

const q = (id: string, title: string): Tab => ({ id, kind: "query", title, sql: "", sqlSessionId: null });

function setup(tabs: Tab[], activeTabId: string | null = tabs[0]?.id ?? null) {
  useWorkspaces.setState({
    workspaces: [{ ...base, tabs, activeTabId, mru: tabs.map((t) => t.id) }],
    activeWorkspaceId: "w1",
    closeRequest: null,
  });
  const Live = () => {
    const w = useWorkspaces((s) => s.workspaces[0]);
    return w ? <TabBar workspace={w} /> : null;
  };
  return render(
    <>
      <Live />
      <CloseConfirm />
    </>,
  );
}

const ws = () => useWorkspaces.getState().workspaces[0];
const tab = (name: string) => screen.getByRole("tab", { name });
/** A capsule's close button (mouse only, hidden from assistive tech). */
const closeButtonOf = (tabName: string) =>
  screen
    .getByRole("tab", { name: tabName })
    .closest("[data-tab-id]")
    ?.querySelector<HTMLButtonElement>('button[aria-hidden="true"]') as HTMLButtonElement;


beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useGridViews.setState({ views: {}, trails: {} });
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
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("capsules_share_width_and_scroll: capsules grow equally from 120 px, then the bar scrolls", () => {
  setup([q("a", "Query 1"), q("b", "Query 2")]);
  const list = screen.getByRole("tablist", { name: strings.workspace.tabsLabel });
  expect(list).toHaveClass("overflow-x-auto");
  for (const name of ["Query 1", "Query 2"]) {
    const capsule = tab(name).closest("[data-tab-id]") as HTMLElement;
    expect(capsule.style.flexGrow).toBe("1");
    expect(capsule.style.flexBasis).toBe("0px");
    expect(capsule.style.minWidth).toBe("120px");
    expect(capsule).toHaveClass("rounded-full");
  }
  // The active capsule uses --tab-sel, the others --tab.
  expect(tab("Query 1").closest("[data-tab-id]")).toHaveClass("bg-tab-sel");
  expect(tab("Query 2").closest("[data-tab-id]")).toHaveClass("bg-tab");
});

test("the active tab scrolls into view when it changes", () => {
  setup([q("a", "Query 1"), q("b", "Query 2")]);
  const spy = vi.mocked(Element.prototype.scrollIntoView);
  spy.mockClear();
  act(() => useWorkspaces.getState().activateTab("w1", "b"));
  expect(spy).toHaveBeenCalled();
  expect(spy.mock.contexts[spy.mock.contexts.length - 1]).toBe(tab("Query 2").closest("[data-tab-id]"));
});

test("a vertical wheel over the bar scrolls it sideways", () => {
  setup([q("a", "Query 1")]);
  const list = screen.getByRole("tablist");
  act(() => {
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true }));
  });
  expect(list.scrollLeft).toBe(80);
});

test("preview_tab_italic: only a preview table tab is in italic", () => {
  setup([
    { id: "p", kind: "table", object: users, title: "users", preview: true },
    q("a", "Query 1"),
  ]);
  expect(within(tab("users")).getByText("users")).toHaveClass("italic");
  expect(within(tab("Query 1")).getByText("Query 1")).not.toHaveClass("italic");
});

test("long_names_truncate: a long name is cut with an ellipsis and shown whole in the tooltip", () => {
  setup([{ id: "t", kind: "table", object: { schema: "public", name: LONG }, title: LONG, preview: false }]);
  const t = tab(LONG);
  expect(t).toHaveAttribute("title", LONG);
  expect(within(t).getByText(LONG)).toHaveClass("truncate");
  expect(t.closest("[data-tab-id]")).toHaveClass("min-w-0");
});

test("tabs follow the tablist pattern: one Tab stop, arrows move, Enter activates", async () => {
  setup([q("a", "Query 1"), q("b", "Query 2"), q("c", "Query 3")]);
  expect(tab("Query 1")).toHaveAttribute("aria-selected", "true");
  expect(tab("Query 1")).toHaveAttribute("tabindex", "0");
  expect(tab("Query 2")).toHaveAttribute("tabindex", "-1");
  // The close buttons are not Tab stops (Delete closes the focused tab).
  const closeQ2 = closeButtonOf("Query 2");
  expect(closeQ2).toHaveAttribute("tabindex", "-1");
  tab("Query 1").focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(tab("Query 2")).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(tab("Query 3")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  expect(tab("Query 1")).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}{Enter}");
  expect(ws().activeTabId).toBe("c");
  await userEvent.keyboard("{Delete}");
  expect(ws().tabs.map((t) => t.id)).toEqual(["a", "b"]);
  expect(tab(ws().activeTabId === "a" ? "Query 1" : "Query 2")).toHaveFocus();
});

test("rename_in_place: the menu's Rename edits the name in the capsule; Enter keeps it", async () => {
  setup([q("a", "Query 1"), q("b", "Query 2")]);
  await userEvent.pointer({ keys: "[MouseRight]", target: tab("Query 2") });
  await userEvent.click(screen.getByRole("menuitem", { name: strings.workspace.tabMenu.rename }));
  const input = screen.getByRole("textbox", { name: strings.workspace.tabMenu.renameLabel });
  expect(input).toHaveFocus();
  expect(input).toHaveValue("Query 2");
  await userEvent.clear(input);
  await userEvent.type(input, "Monthly report{Enter}");
  expect(ws().tabs[1].title).toBe("Monthly report");
  expect(tab("Monthly report")).toHaveFocus();
});

test("rename: Escape cancels and an empty name is refused", async () => {
  setup([q("a", "Query 1")]);
  tab("Query 1").focus();
  await userEvent.keyboard("{F2}");
  let input = screen.getByRole("textbox", { name: strings.workspace.tabMenu.renameLabel });
  await userEvent.type(input, "zzz{Escape}");
  expect(ws().tabs[0].title).toBe("Query 1");
  expect(tab("Query 1")).toHaveFocus();

  await userEvent.keyboard("{F2}");
  input = screen.getByRole("textbox", { name: strings.workspace.tabMenu.renameLabel });
  await userEvent.clear(input);
  await userEvent.keyboard("{Enter}");
  // Still editing, marked invalid, nothing renamed.
  expect(input).toBeInTheDocument();
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription(strings.workspace.tabMenu.renameEmpty);
  expect(ws().tabs[0].title).toBe("Query 1");
  // Leaving the field with an empty name cancels.
  await userEvent.tab();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(ws().tabs[0].title).toBe("Query 1");
});

test("close_others: the tab menu closes the other tabs", async () => {
  setup([q("a", "Query 1"), q("b", "Query 2"), q("c", "Query 3")]);
  await userEvent.pointer({ keys: "[MouseRight]", target: tab("Query 2") });
  const menu = screen.getByRole("menu", { name: strings.workspace.tabMenu.label });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
    strings.workspace.tabMenu.newTab,
    strings.workspace.tabMenu.close,
    strings.workspace.tabMenu.closeOthers,
    strings.workspace.tabMenu.rename,
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: strings.workspace.tabMenu.closeOthers }));
  expect(ws().tabs.map((t) => t.id)).toEqual(["b"]);
  expect(ws().activeTabId).toBe("b");
});

test("the tab menu opens from the keyboard and gives the focus back on Escape", async () => {
  setup([q("a", "Query 1"), q("b", "Query 2")]);
  tab("Query 1").focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  expect(screen.getByRole("menuitem", { name: strings.workspace.tabMenu.newTab })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(tab("Query 1")).toHaveFocus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await userEvent.click(screen.getByRole("menuitem", { name: strings.workspace.tabMenu.newTab }));
  expect(ws().tabs).toHaveLength(3);
});

test("closing a tab with pending changes from the menu still asks first", async () => {
  setup([{ id: "t", kind: "table", object: users, title: "users", preview: false }, q("a", "Query 1")]);
  usePendingChanges.getState().addInsert("t", users);
  await userEvent.pointer({ keys: "[MouseRight]", target: tab("users") });
  await userEvent.click(screen.getByRole("menuitem", { name: strings.workspace.tabMenu.close }));
  expect(ws().tabs).toHaveLength(2);
  expect(useWorkspaces.getState().closeRequest).toMatchObject({ tabId: "t", count: 1 });
});

test("back_forward_navigation: the arrows walk the history and are disabled at its ends", async () => {
  setup([q("a", "Query 1"), q("b", "Query 2")]);
  const back = screen.getByRole("button", { name: strings.workspace.back });
  const forward = screen.getByRole("button", { name: strings.workspace.forward });
  expect(back).toBeDisabled();
  expect(forward).toBeDisabled();
  expect(back).toHaveAttribute("title", strings.workspace.backTitle("Alt+←"));
  await userEvent.click(tab("Query 2"));
  expect(back).toBeEnabled();
  await userEvent.click(back);
  expect(ws().activeTabId).toBe("a");
  expect(forward).toBeEnabled();
  await userEvent.click(forward);
  expect(ws().activeTabId).toBe("b");
});

test("back first goes back along the foreign key trail of the active table tab", async () => {
  const orders: ObjectRef = { schema: "public", name: "orders" };
  setup([{ id: "t", kind: "table", object: users, title: "users", preview: false }]);
  act(() => useGridViews.setState({ trails: { t: [{ object: orders, view: { page: 0, sort: null, filters: [] } }] } }));
  const back = screen.getByRole("button", { name: strings.workspace.back });
  expect(back).toBeEnabled();
  await userEvent.click(back);
  expect(ws().tabs[0]).toMatchObject({ object: orders, title: "orders" });
  expect(back).toBeDisabled();
});

test("the split button is disabled and says why", () => {
  setup([q("a", "Query 1")]);
  const split = screen.getByRole("button", { name: strings.workspace.split });
  expect(split).toHaveAttribute("aria-disabled", "true");
  expect(split).toHaveAttribute("title", strings.workspace.splitSoon);
});

test("middle click closes a tab and a double click pins a preview tab", async () => {
  setup([{ id: "p", kind: "table", object: users, title: "users", preview: true }, q("a", "Query 1")]);
  await userEvent.dblClick(tab("users"));
  expect(ws().tabs[0]).toMatchObject({ preview: false });
  await userEvent.pointer({ keys: "[MouseMiddle]", target: tab("Query 1") });
  expect(ws().tabs.map((t) => t.id)).toEqual(["p"]);
});

// ---- Fix round 1 ----

const users2: ObjectRef = { schema: "public", name: "orders" };
const pendingTabs = () => [
  { id: "t", kind: "table" as const, object: users, title: "users", preview: false },
  { id: "o", kind: "table" as const, object: users2, title: "orders", preview: false },
  q("a", "Query 1"),
];
const cancel = () => screen.getByRole("button", { name: strings.grid.discardCancel });

test("Close from the menu with pending changes leaves the focus on the dialog's Cancel", async () => {
  setup(pendingTabs());
  usePendingChanges.getState().addInsert("t", users);
  await userEvent.pointer({ keys: "[MouseRight]", target: tab("users") });
  await userEvent.click(screen.getByRole("menuitem", { name: strings.workspace.tabMenu.close }));
  await act(async () => {});
  expect(cancel()).toHaveFocus();
});

test("Close others from the menu with pending changes leaves the focus on the dialog's Cancel", async () => {
  setup(pendingTabs());
  usePendingChanges.getState().addInsert("t", users);
  await userEvent.pointer({ keys: "[MouseRight]", target: tab("Query 1") });
  await userEvent.click(screen.getByRole("menuitem", { name: strings.workspace.tabMenu.closeOthers }));
  await act(async () => {});
  expect(cancel()).toHaveFocus();
});

test("Delete with pending changes then Cancel: a later update never pulls the focus to the tabs", async () => {
  setup(pendingTabs());
  usePendingChanges.getState().addInsert("t", users);
  tab("users").focus();
  await userEvent.keyboard("{Delete}");
  await userEvent.click(cancel());
  expect(ws().tabs).toHaveLength(3);
  const field = document.createElement("input");
  document.body.appendChild(field);
  field.focus();
  act(() => {
    useWorkspaces.getState().renameTab("w1", "a", "Other name");
  });
  await act(async () => {});
  expect(field).toHaveFocus();
  field.remove();
});

test("a real close from the menu moves the focus to the new active tab", async () => {
  setup([q("a", "Query 1"), q("b", "Query 2")], "b");
  await userEvent.pointer({ keys: "[MouseRight]", target: tab("Query 2") });
  await userEvent.click(screen.getByRole("menuitem", { name: strings.workspace.tabMenu.close }));
  expect(ws().tabs.map((t) => t.id)).toEqual(["a"]);
  expect(tab("Query 1")).toHaveFocus();
});

test("close buttons are hidden from assistive tech; the tabs announce their keys", () => {
  setup([q("a", "Query 1"), q("b", "Query 2")]);
  const list = screen.getByRole("tablist");
  // Only tabs are exposed inside the tablist (aria-required-children).
  expect(within(list).queryAllByRole("button")).toHaveLength(0);
  expect(within(list).getAllByRole("tab")).toHaveLength(2);
  for (const b of within(list).getAllByRole("button", { hidden: true })) {
    expect(b).toHaveAttribute("aria-hidden", "true");
  }
  expect(tab("Query 1")).toHaveAttribute("aria-keyshortcuts", "Delete F2 Shift+F10");
});

test("the close button of the active capsule has a hover colour that differs from the capsule", () => {
  setup([q("a", "Query 1"), q("b", "Query 2")]);
  const activeClose = closeButtonOf("Query 1");
  const otherClose = closeButtonOf("Query 2");
  expect(activeClose).toHaveClass("hover:bg-tab");
  expect(activeClose).not.toHaveClass("hover:bg-tab-sel");
  expect(otherClose).toHaveClass("hover:bg-tab-sel");
});

test("lone_tab: a single tab spans the bar and shows its close button on hover only (#103)", () => {
  setup([q("a", "Query 1")]);
  const capsule = tab("Query 1").closest("[data-tab-id]") as HTMLElement;
  expect(capsule.style.flexGrow).toBe("1");
  const close = closeButtonOf("Query 1");
  expect(close).toHaveClass("opacity-0", "group-hover:opacity-100");
  expect(close).not.toHaveClass("opacity-100");
  // With another tab the active one shows it at once.
  act(() =>
    useWorkspaces.setState((s) => ({
      workspaces: s.workspaces.map((w) => ({ ...w, tabs: [...w.tabs, q("b", "Query 2")] })),
    })),
  );
  expect(closeButtonOf("Query 1")).toHaveClass("opacity-100");
});

test("inactive capsule text and the database badge use the tab text token", () => {
  setup([
    q("a", "Query 1"),
    { id: "b", kind: "query", title: "Query 2", sql: "", sqlSessionId: "s", database: "app" },
  ]);
  act(() =>
    useWorkspaces.setState((s) => ({ workspaces: s.workspaces.map((w) => ({ ...w, database: "other" })) })),
  );
  const capsule = screen.getByRole("tab", { name: /Query 2/ }).closest("[data-tab-id]");
  expect(capsule).toHaveClass("text-tab-text");
  expect(capsule).not.toHaveClass("text-text-2");
  const badge = screen.getByTitle(strings.workspace.tabDatabase("app"));
  expect(badge.className).not.toMatch(/text-text-2/);
});
