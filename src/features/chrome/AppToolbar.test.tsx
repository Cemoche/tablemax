import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { useConnections } from "../../stores/connections";
import { usePendingChanges } from "../../stores/pendingChanges";
import { useQueryRuns } from "../../stores/queryRuns";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { onWindowResized } from "../../lib/windowResize";
import { expectSoftDisabled } from "../../test/softDisabled";
import { AppToolbar } from "./AppToolbar";
import { ResizeHandles } from "./ResizeHandles";
import { TooltipLayer } from "./TooltipLayer";

vi.mock("../../lib/ipc");
vi.mock("../../lib/windowResize", () => ({ onWindowResized: vi.fn(async () => () => {}) }));

const t = strings.toolbar;
const obj = { schema: "public", name: "orders" };

const cfg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "c1",
  name: "Shop",
  color: "swatch-2",
  envTag: "prod",
  kind: "postgres",
  host: "db.internal",
  port: 5432,
  user: "app",
  database: "shop",
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: "verifyFull", caFile: null, certFile: null, keyFile: null },
  ssh: null,
  ...over,
});

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  connectionId: "c1",
  name: "Shop",
  color: "swatch-2",
  envTag: "prod",
  dialect: "postgres",
  status: "connected",
  serverVersion: "16.4",
  database: "shop",
  schemas: ["public"],
  currentSchema: "public",
  tabs: [
    { id: "t1", kind: "table", object: obj, title: "orders", preview: false },
    { id: "q1", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
  ],
  activeTabId: "t1",
  mru: ["t1", "q1"],
  ...over,
});

const setup = (w: Workspace = ws()) => {
  useWorkspaces.setState({ workspaces: [w], activeWorkspaceId: w.id, sidebarVisible: true });
  const onEdit = vi.fn();
  const view = render(
    <>
      <AppToolbar workspace={w} onEditConnection={onEdit} />
      <ResizeHandles />
    </>,
  );
  return { onEdit, view, header: screen.getByRole("banner") };
};

/** Accessible names of the toolbar's buttons, in DOM order. */
const buttonNames = (header: HTMLElement) =>
  within(header)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useConnections.setState({ items: [cfg()] });
  useSettings.setState({ settings: DEFAULT_SETTINGS, systemTitleBar: false });
  useChrome.setState({ rowDetailsOpen: false, reloads: {}, previews: {}, paletteRequest: null, maximized: false });
  vi.mocked(onWindowResized).mockImplementation(async () => () => {});
  usePendingChanges.getState().drop("t1");
  usePendingChanges.setState({ committing: {}, committingIn: {}, confirming: {}, awaitingReload: {} });
  useQueryRuns.setState({ runs: {} });
});
afterEach(() => vi.restoreAllMocks());

test("toolbar_groups_in_spec_order", () => {
  const { header } = setup();
  // Spec §2.3: sidebar · connection | Discard · Preview · Commit | safe mode · database · SQL |
  // status pill | reload · Open Anything | row details; then the window buttons.
  expect(within(header).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
    t.groups.navigation,
    t.groups.changes,
    t.groups.database,
    t.groups.search,
    t.groups.panels,
    strings.window.controls,
  ]);
  expect(buttonNames(header)).toEqual([
    t.sidebar,
    t.connection,
    t.discard,
    t.preview,
    t.commit,
    t.safeMode(strings.safety.bannerModeConfirmWrites),
    t.database,
    t.sql,
    `${strings.statusPill.tags.prod}${strings.statusPill.tagSeparator}PostgreSQL 16.4 : Shop : shop : public.orders`,
    t.reload,
    t.openAnything,
    t.rowDetails,
    strings.window.minimize,
    strings.window.maximize,
    strings.window.close,
  ]);
  // Features TableMax does not have are not shown (spec §3).
  expect(within(header).queryByRole("button", { name: /console/i })).toBeNull();
});

test("commit_group_follows_pending_changes", async () => {
  const user = userEvent.setup();
  const commit = vi.fn();
  const discard = vi.fn();
  usePendingChanges.setState({ commit, discard });
  setup();
  const button = (name: string) => screen.getByRole("button", { name });
  for (const name of [t.discard, t.preview, t.commit]) expect(button(name)).toHaveAttribute("aria-disabled", "true");

  act(() => {
    usePendingChanges.getState().addInsert("t1", obj);
  });
  for (const name of [t.discard, t.preview, t.commit]) expect(button(name)).not.toHaveAttribute("aria-disabled");
  await user.click(button(t.commit));
  expect(commit).toHaveBeenCalledWith("t1", "w1", obj);
  await user.click(button(t.discard));
  expect(discard).toHaveBeenCalledWith("t1");
  await user.click(button(t.preview));
  expect(useChrome.getState().previews.t1).toBe(1);

  // A running commit locks Commit; Discard gives way to Cancel the commit (below).
  act(() => usePendingChanges.setState({ committing: { t1: true } }));
  expect(button(t.commit)).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("button", { name: t.discard })).toBeNull();
});

test("commit_group_soft_disabled: with nothing pending Discard, Preview and Commit keep their tooltip and do nothing (#110)", async () => {
  const user = userEvent.setup();
  const commit = vi.fn();
  const discard = vi.fn();
  usePendingChanges.setState({ commit, discard });
  render(<TooltipLayer />);
  setup();
  const button = (name: string) => screen.getByRole("button", { name });
  await expectSoftDisabled(user, button(t.discard), t.discard, () => discard.mock.calls.length > 0);
  await expectSoftDisabled(user, button(t.preview), t.preview, () => useChrome.getState().previews.t1 !== undefined);
  await expectSoftDisabled(user, button(t.commit), t.commit, () => commit.mock.calls.length > 0);
  // The commit's other reasons, with changes pending: its own commit running, an unknown
  // outcome of the last one, the cell editor open.
  act(() => {
    usePendingChanges.getState().addInsert("t1", obj);
  });
  const offWhile = async (on: () => void, off: () => void) => {
    act(on);
    expect(button(t.commit)).toHaveAttribute("aria-disabled", "true");
    await user.click(button(t.commit));
    expect(commit).not.toHaveBeenCalled();
    act(off);
    expect(button(t.commit)).not.toHaveAttribute("aria-disabled");
  };
  await offWhile(
    () => usePendingChanges.setState({ committing: { t1: true } }),
    () => usePendingChanges.setState({ committing: {} }),
  );
  const tab = () => usePendingChanges.getState().tabs.t1;
  await offWhile(
    () => usePendingChanges.setState((s) => ({ tabs: { ...s.tabs, t1: { ...tab(), outcomeUnknown: true } } })),
    () => usePendingChanges.setState((s) => ({ tabs: { ...s.tabs, t1: { ...tab(), outcomeUnknown: false } } })),
  );
  await offWhile(
    () => usePendingChanges.setState({ editorOpen: { t1: true } }),
    () => usePendingChanges.setState({ editorOpen: {} }),
  );
  await user.click(button(t.commit));
  expect(commit).toHaveBeenCalledTimes(1);
});

test("a press or a double press on an off toolbar button never moves nor maximizes the window (#110)", async () => {
  const user = userEvent.setup();
  setup();
  const preview = screen.getByRole("button", { name: t.preview });
  expect(preview).toHaveAttribute("aria-disabled", "true");
  await user.click(preview);
  await user.dblClick(preview);
  expect(ipc.windowStartDrag).not.toHaveBeenCalled();
  expect(ipc.windowToggleMaximize).not.toHaveBeenCalled();
});

test("toolbar_buttons_soft_disabled: Sidebar, Database and Reload off while disconnected, Row details outside a table tab (#110)", async () => {
  const user = userEvent.setup();
  render(<TooltipLayer />);
  setup(ws({ status: "disconnected" }));
  const button = (name: string) => screen.getByRole("button", { name });
  await expectSoftDisabled(user, button(t.sidebar), t.sidebar, () => !useWorkspaces.getState().sidebarVisible);
  await expectSoftDisabled(user, button(t.database), t.database, () => useChrome.getState().paletteRequest !== null);
  // Reload and Row details: their handlers also check the state (`reloadWorkspace` returns
  // while disconnected, Row details needs a table tab), and neither has a store seam ahead of
  // that check, so these two "does nothing" checks cannot fail by themselves. The click guard
  // itself is proven in src/lib/softDisabled.test.tsx; here they check aria-disabled, the
  // tooltip on hover and focus, and that the button is reachable.
  await expectSoftDisabled(user, button(t.reload), t.reload, () => Object.keys(useChrome.getState().reloads).length > 0);
  await expectSoftDisabled(user, button(t.rowDetails), t.rowDetails, () => useChrome.getState().rowDetailsOpen);
});

test("commit_group_replaces_the_edit_strip: pending count, Cancel while committing, another tab committing (#103)", async () => {
  const user = userEvent.setup();
  const cancelCommit = vi.fn(async () => {});
  usePendingChanges.setState({ cancelCommit });
  setup();
  const commit = screen.getByRole("button", { name: t.commit });
  expect(within(commit).queryByTestId("pending-count")).toBeNull();
  act(() => {
    usePendingChanges.getState().addInsert("t1", obj);
    usePendingChanges.getState().addInsert("t1", obj);
  });
  // The count shows on Commit and is part of its description.
  expect(within(commit).getByTestId("pending-count")).toHaveTextContent("2");
  expect(commit).toHaveAccessibleDescription(strings.grid.pendingCount(2));

  // Committing: Discard's place holds Cancel the commit (the strip's Cancel).
  act(() => usePendingChanges.setState({ committing: { t1: true }, committingIn: { w1: "t1" } }));
  const cancel = screen.getByRole("button", { name: strings.grid.cancelCommitLabel });
  expect(cancel).toBeEnabled();
  await user.click(cancel);
  expect(cancelCommit).toHaveBeenCalledWith("t1", "w1");

  // Another table tab of the workspace commits: Commit waits, and says why. It stays
  // focusable (aria-disabled, review #109) so its reason can be read; it does nothing.
  const commitSpy = vi.fn(async () => true);
  act(() => usePendingChanges.setState({ committing: {}, committingIn: { w1: "t9" }, commit: commitSpy }));
  expect(commit).not.toBeDisabled();
  expect(commit).toHaveAttribute("aria-disabled", "true");
  expect(commit).toHaveAttribute("data-tooltip", strings.grid.otherTabCommitting);
  expect(commit).toHaveAccessibleDescription(
    `${strings.grid.pendingCount(2)} ${strings.grid.otherTabCommitting}`,
  );
  await user.click(commit);
  act(() => commit.focus());
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  expect(commitSpy).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: t.discard })).not.toHaveAttribute("aria-disabled");
  // A tab of another workspace committing never blocks this one.
  act(() => usePendingChanges.setState({ committingIn: { w2: "tX" } }));
  expect(commit).not.toHaveAttribute("aria-disabled");
  expect(commit).toHaveAccessibleDescription(strings.grid.pendingCount(2));
  expect(commit).not.toHaveAttribute("data-tooltip", strings.grid.otherTabCommitting);
  act(() => usePendingChanges.setState({ committingIn: {} }));
  expect(commit).not.toHaveAttribute("aria-disabled");
  expect(commit).not.toHaveAttribute("data-tooltip", strings.grid.otherTabCommitting);
});

test("the commit group is off on a SQL tab and on a disconnected workspace", () => {
  usePendingChanges.getState().addInsert("t1", obj);
  setup(ws({ activeTabId: "q1" }));
  expect(screen.getByRole("button", { name: t.commit })).toHaveAttribute("aria-disabled", "true");
});

test("toolbar_is_keyboard_reachable", async () => {
  const user = userEvent.setup();
  const { header } = setup();
  const enabled = within(header)
    .getAllByRole("button")
    .filter((b) => !(b as HTMLButtonElement).disabled);
  const reached: Element[] = [];
  for (let i = 0; i < enabled.length; i++) {
    await user.tab();
    reached.push(document.activeElement as Element);
  }
  expect(reached).toEqual(enabled);
  for (const b of enabled) {
    // A name for every control, and a visible focus ring.
    expect(b.getAttribute("aria-label") ?? b.textContent).toBeTruthy();
    // (Tailwind 4: outline-none also sets the style to none, so the ring sets it back.)
    expect(b.className).toContain("focus-visible:outline-solid");
  }
});

test("double_click_toolbar_toggles_maximize", async () => {
  const user = userEvent.setup();
  const { header } = setup();
  await user.dblClick(header);
  // The first press starts a window move, the second one (detail 2) maximizes or restores.
  expect(ipc.windowStartDrag).toHaveBeenCalledTimes(1);
  expect(ipc.windowToggleMaximize).toHaveBeenCalledTimes(1);

  // Not on a button.
  await user.dblClick(screen.getByRole("button", { name: t.reload }));
  expect(ipc.windowToggleMaximize).toHaveBeenCalledTimes(1);
  expect(ipc.windowStartDrag).toHaveBeenCalledTimes(1);
});

test("a press on the discard dialog's overlay (portalled) never moves nor maximizes the window", async () => {
  const user = userEvent.setup();
  usePendingChanges.setState({ discard: vi.fn() });
  setup();
  act(() => {
    usePendingChanges.getState().addInsert("t1", obj);
  });
  await user.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
  const overlay = screen.getByRole("dialog", { name: strings.grid.discardTitle }).parentElement as HTMLElement;
  await user.pointer({ keys: "[MouseLeft]", target: overlay });
  await user.dblClick(overlay);
  expect(ipc.windowStartDrag).not.toHaveBeenCalled();
  expect(ipc.windowToggleMaximize).not.toHaveBeenCalled();
});

test("after a discard by shortcut whose opener is gone, the active tab takes the focus", async () => {
  const user = userEvent.setup();
  usePendingChanges.setState({ discard: vi.fn() });
  setup();
  const content = document.createElement("div");
  content.tabIndex = -1;
  content.setAttribute("data-tab-content", "");
  const opener = document.createElement("button");
  document.body.append(content, opener);
  act(() => {
    usePendingChanges.getState().addInsert("t1", obj);
  });
  opener.focus();
  await user.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
  opener.remove();
  await user.keyboard("{Enter}");
  expect(content).toHaveFocus();
  content.remove();
});

test("the window buttons minimize, maximize and close through Rust", async () => {
  const user = userEvent.setup();
  setup();
  await user.click(screen.getByRole("button", { name: strings.window.minimize }));
  await user.click(screen.getByRole("button", { name: strings.window.maximize }));
  await user.click(screen.getByRole("button", { name: strings.window.close }));
  expect(ipc.windowMinimize).toHaveBeenCalledTimes(1);
  expect(ipc.windowToggleMaximize).toHaveBeenCalledTimes(1);
  expect(ipc.windowClose).toHaveBeenCalledTimes(1);
});

const onPlatform = (platform: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);

test("the resize handles start a resize in their direction (off Linux)", () => {
  onPlatform("Win32");
  setup();
  const handles = document.querySelectorAll("[data-resize]");
  expect([...handles].map((h) => h.getAttribute("data-resize")).sort()).toEqual(
    ["East", "North", "NorthEast", "NorthWest", "South", "SouthEast", "SouthWest", "West"],
  );
  const ne = document.querySelector('[data-resize="NorthEast"]') as HTMLElement;
  ne.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  expect(ipc.windowStartResize).toHaveBeenCalledWith("NorthEast");
});

test("no resize grips on Linux: the runtime gives the undecorated window its own border", () => {
  setup();
  expect(document.querySelectorAll("[data-resize]")).toHaveLength(0);
});

test("no resize grips while maximized; the maximize button says Restore", async () => {
  onPlatform("Win32");
  const user = userEvent.setup();
  vi.mocked(ipc.windowToggleMaximize).mockResolvedValue(true);
  setup();
  expect(document.querySelectorAll("[data-resize]")).toHaveLength(8);
  await user.click(screen.getByRole("button", { name: strings.window.maximize }));
  expect(await screen.findByRole("button", { name: strings.window.restore })).toBeInTheDocument();
  expect(document.querySelectorAll("[data-resize]")).toHaveLength(0);
  vi.mocked(ipc.windowToggleMaximize).mockResolvedValue(false);
  await user.click(screen.getByRole("button", { name: strings.window.restore }));
  expect(await screen.findByRole("button", { name: strings.window.maximize })).toBeInTheDocument();
  expect(document.querySelectorAll("[data-resize]")).toHaveLength(8);
});

test("a maximize or restore done by the desktop is followed (resize event)", async () => {
  let resized: () => void = () => {};
  vi.mocked(onWindowResized).mockImplementation(async (h) => {
    resized = h;
    return () => {};
  });
  vi.mocked(ipc.windowIsMaximized).mockResolvedValue(false);
  setup();
  await waitFor(() => expect(ipc.windowIsMaximized).toHaveBeenCalled());
  vi.mocked(ipc.windowIsMaximized).mockResolvedValue(true);
  act(() => resized());
  expect(await screen.findByRole("button", { name: strings.window.restore })).toBeInTheDocument();
});

test("the space around the status pill moves and maximizes the window", async () => {
  const user = userEvent.setup();
  setup();
  const pill = screen.getByRole("button", { name: /PostgreSQL 16\.4/ });
  // The pill fills a wrapper that takes the free space (#104); the wrapper's padding on
  // both sides is left for moving the window.
  expect(pill.className).toContain("w-full");
  const area = pill.parentElement as HTMLElement;
  expect(area).toHaveAttribute("data-pill-area");
  expect(area.className).toContain("flex-1");
  expect(area.className).toMatch(/\bpx-\d/);
  await user.dblClick(area);
  expect(ipc.windowStartDrag).toHaveBeenCalledTimes(1);
  expect(ipc.windowToggleMaximize).toHaveBeenCalledTimes(1);
  // The pill itself still opens the connection popover, and never moves the window.
  await user.click(pill);
  expect(screen.getByRole("dialog", { name: strings.connectionPopover.label })).toBeInTheDocument();
  expect(ipc.windowStartDrag).toHaveBeenCalledTimes(1);
});

test("system_title_bar_setting_hides_window_controls", async () => {
  useSettings.setState({ systemTitleBar: true });
  const user = userEvent.setup();
  const { header } = setup();
  expect(within(header).queryByRole("group", { name: strings.window.controls })).toBeNull();
  expect(screen.queryByRole("button", { name: strings.window.close })).toBeNull();
  expect(document.querySelectorAll("[data-resize]")).toHaveLength(0);
  // The native title bar moves and maximizes the window.
  await user.dblClick(header);
  expect(ipc.windowStartDrag).not.toHaveBeenCalled();
  expect(ipc.windowToggleMaximize).not.toHaveBeenCalled();
});

test("toolbar buttons run their actions", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.catalogGet).mockResolvedValue({ schema: "public", tables: [] });
  setup();
  await user.click(screen.getByRole("button", { name: t.sql }));
  expect(useWorkspaces.getState().workspaces[0].tabs.filter((x) => x.kind === "query")).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: t.reload }));
  // The sidebar (workspace id) and the table tab reload; the catalog is rebuilt.
  expect(useChrome.getState().reloads).toEqual({ w1: 1, t1: 1 });
  expect(ipc.catalogGet).toHaveBeenCalledWith("w1", "public", true);

  await user.click(screen.getByRole("button", { name: t.openAnything }));
  expect(useChrome.getState().paletteRequest).toMatchObject({ kind: "all" });
  await user.click(screen.getByRole("button", { name: t.database }));
  expect(useChrome.getState().paletteRequest).toMatchObject({ kind: "database" });

  const details = screen.getByRole("button", { name: t.rowDetails });
  expect(details).toHaveAttribute("aria-pressed", "false");
  await user.click(details);
  expect(useChrome.getState().rowDetailsOpen).toBe(true);
  expect(details).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: t.sidebar }));
  expect(useWorkspaces.getState().sidebarVisible).toBe(false);
});

test("Ctrl+R reloads the workspace", async () => {
  setup();
  await userEvent.setup().keyboard("{Control>}r{/Control}");
  expect(useChrome.getState().reloads).toEqual({ w1: 1, t1: 1 });
});

test("discard_preview_shortcuts: Ctrl+Shift+Backspace / Ctrl+Shift+P act like the buttons, never in a field (#90)", async () => {
  const user = userEvent.setup();
  const discard = vi.fn();
  usePendingChanges.setState({ discard });
  setup();
  // Their tooltips name the keys.
  expect(screen.getByRole("button", { name: t.discard })).toHaveAttribute("data-tooltip-key", "Ctrl+Shift+Backspace");
  expect(screen.getByRole("button", { name: t.preview })).toHaveAttribute("data-tooltip-key", "Ctrl+Shift+P");
  // Nothing pending: nothing happens.
  await user.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
  await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  expect(discard).not.toHaveBeenCalled();
  expect(useChrome.getState().previews.t1).toBeUndefined();
  act(() => {
    usePendingChanges.getState().addInsert("t1", obj);
  });
  await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  expect(useChrome.getState().previews.t1).toBe(1);
  // In a text field Ctrl+Shift+Backspace stays the field's.
  const field = document.createElement("input");
  document.body.appendChild(field);
  field.focus();
  await user.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
  expect(discard).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  field.remove();
  // Elsewhere it asks first (no undo); Cancel keeps the changes and gives the focus back.
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  await user.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
  const ask = screen.getByRole("dialog", { name: strings.grid.discardTitle });
  expect(ask).toHaveTextContent(strings.grid.discardConfirm(1));
  expect(discard).not.toHaveBeenCalled();
  await user.click(within(ask).getByRole("button", { name: strings.grid.discardCancel }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(discard).not.toHaveBeenCalled();
  expect(opener).toHaveFocus();
  // Escape cancels too; Enter discards (Discard has the focus).
  await user.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(discard).not.toHaveBeenCalled();
  await user.keyboard("{Control>}{Shift>}{Backspace}{/Shift}{/Control}");
  expect(screen.getByRole("button", { name: strings.grid.discardOk })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(discard).toHaveBeenCalledWith("t1");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener).toHaveFocus();
  opener.remove();
});

test("discard_preview_off_in_query_tabs: their keys are not taken where no table tab is active (#90)", async () => {
  setup(ws({ activeTabId: "q1" }));
  const backspace = new KeyboardEvent("keydown", {
    key: "Backspace",
    code: "Backspace",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  const p = new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(backspace);
  document.body.dispatchEvent(p);
  expect(backspace.defaultPrevented).toBe(false);
  expect(p.defaultPrevented).toBe(false);
});

test("reload_tab_and_reconnect: Alt+R reloads the table tab only; Ctrl+Shift+R reconnects a disconnected workspace (#90)", async () => {
  const user = userEvent.setup();
  setup();
  await user.keyboard("{Alt>}r{/Alt}");
  expect(useChrome.getState().reloads).toEqual({ t1: 1 });
  // A connected workspace has nothing to reconnect.
  const requestConnect = vi.fn();
  useWorkspaces.setState({ requestConnect });
  await user.keyboard("{Control>}{Shift>}r{/Shift}{/Control}");
  expect(requestConnect).not.toHaveBeenCalled();
});

test("Ctrl+Shift+R reconnects the disconnected workspace on screen (#90)", async () => {
  const requestConnect = vi.fn();
  setup(ws({ status: "disconnected" }));
  useWorkspaces.setState({ requestConnect });
  await userEvent.setup().keyboard("{Control>}{Shift>}r{/Shift}{/Control}");
  expect(requestConnect).toHaveBeenCalledWith("w1");
  // Alt+R: no table tab is loaded in a disconnected workspace.
  await userEvent.setup().keyboard("{Alt>}r{/Alt}");
  expect(useChrome.getState().reloads).toEqual({});
});

test("the safe mode menu shows the enforced mode and saves the connection's level", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockImplementation(async (c) => c);
  setup();
  // prod without an explicit mode confirms writes.
  await user.click(screen.getByRole("button", { name: t.safeMode(strings.safety.bannerModeConfirmWrites) }));
  const menu = screen.getByRole("menu", { name: t.safeModeMenu });
  const items = within(menu).getAllByRole("menuitemradio");
  expect(items.map((i) => i.textContent)).toEqual([
    strings.safety.defaultOption(strings.safety.modeConfirmWrites),
    strings.safety.modeOff,
    strings.safety.modeConfirmWrites,
    strings.safety.modeConfirmAll,
  ]);
  expect(items[0]).toHaveAttribute("aria-checked", "true");
  expect(items[0]).toHaveFocus();
  await user.click(items[3]);
  expect(ipc.connectionSave).toHaveBeenCalledWith({ ...cfg(), safeMode: "confirmAll" }, null, null);
  expect(screen.queryByRole("menu")).toBeNull();
  // Tightening applies at once.
  expect(
    await screen.findByRole("button", { name: t.safeMode(strings.safety.bannerModeConfirmAll) }),
  ).toBeInTheDocument();
});

test("a looser saved mode stays enforced until the next open, and the menu says so", async () => {
  const user = userEvent.setup();
  useConnections.setState({ items: [cfg({ safeMode: "off" })] });
  setup();
  // Opened as prod (confirm writes), switched off since: still confirms writes.
  await user.click(screen.getByRole("button", { name: t.safeMode(strings.safety.bannerModeConfirmWrites) }));
  const menu = screen.getByRole("menu");
  expect(within(menu).getByRole("menuitemradio", { name: strings.safety.modeOff })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(within(menu).getByText(t.safeModeLater)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: t.safeMode(strings.safety.bannerModeConfirmWrites) })).toHaveFocus();
});

test("the connections screen shows only the settings, the title and the window buttons", () => {
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null });
  render(<AppToolbar workspace={null} onEditConnection={vi.fn()} />);
  const header = screen.getByRole("banner");
  expect(within(header).getByText(strings.appName)).toBeInTheDocument();
  expect(buttonNames(header)).toEqual([
    strings.settings.open,
    strings.window.minimize,
    strings.window.maximize,
    strings.window.close,
  ]);
});

test("the sidebar button names Ctrl+0", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  setup();
  const sidebar = screen.getByRole("button", { name: t.sidebar });
  // Tooltip (#109): the label, and the key from the live keymap; no native title.
  expect(sidebar).toHaveAttribute("data-tooltip", t.sidebar);
  expect(sidebar).toHaveAttribute("data-tooltip-key", "Ctrl+0");
  expect(sidebar).not.toHaveAttribute("title");
});

test("on the connections screen a gear button opens the settings", async () => {
  useWorkspaces.setState({ workspaces: [], activeWorkspaceId: null });
  useChrome.setState({ settingsRequest: 0 });
  render(<AppToolbar workspace={null} onEditConnection={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: strings.settings.open }));
  expect(useChrome.getState().settingsRequest).toBe(1);
});

test("a failed safe mode save is the button's description, not only its tooltip (review #109)", async () => {
  const user = userEvent.setup();
  vi.mocked(ipc.connectionSave).mockRejectedValue({ kind: "io", message: "disk full" });
  setup();
  const button = screen.getByRole("button", { name: t.safeMode(strings.safety.bannerModeConfirmWrites) });
  await user.click(button);
  await user.click(within(screen.getByRole("menu")).getAllByRole("menuitemradio")[3]);
  await waitFor(() => expect(button).toHaveAccessibleDescription(expect.stringContaining("disk full")));
  expect(button).toHaveAttribute("data-tooltip", expect.stringContaining("disk full"));
  // The icon turns red: --danger-text alone, without text-icon (a later rule, it would win, #129).
  expect(button).toHaveClass("text-danger-text");
  expect(button).not.toHaveClass("text-icon");
});

test("the command palette button opens Open anything with Ctrl+P in its tooltip (#104)", async () => {
  const user = userEvent.setup();
  setup();
  const group = screen.getByRole("group", { name: t.groups.search });
  // [reload] [command palette]: no metrics button (TableMax has no metrics view).
  expect(within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
    t.reload,
    t.openAnything,
  ]);
  const palette = within(group).getByRole("button", { name: t.openAnything });
  expect(palette).toHaveAttribute("data-tooltip", t.openAnything);
  expect(palette).toHaveAttribute("data-tooltip-key", "Ctrl+P");
  // A command glyph, as the reference's command palette button.
  expect(palette.querySelector("svg.lucide-command")).not.toBeNull();
  await user.click(palette);
  expect(useChrome.getState().paletteRequest).toMatchObject({ kind: "all" });
  // [right panel] alone in the last group: no console panel (not built yet).
  const panels = screen.getByRole("group", { name: t.groups.panels });
  expect(within(panels).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([t.rowDetails]);
});

test("with open workspaces the settings are in the connections column, not in the toolbar (#104)", () => {
  useWorkspaces.setState({ workspaces: [ws()], activeWorkspaceId: "w1" });
  render(<AppToolbar workspace={null} onEditConnection={vi.fn()} />);
  expect(within(screen.getByRole("banner")).queryByRole("button", { name: strings.settings.open })).toBeNull();
});

test("the row details button is one switch for the window, off and disabled in a SQL tab without results", () => {
  useChrome.setState({ rowDetailsOpen: true });
  setup(ws({ activeTabId: "q1" }));
  const details = screen.getByRole("button", { name: t.rowDetails });
  expect(details).toHaveAttribute("aria-disabled", "true");
  expect(details).toHaveAttribute("aria-pressed", "false");
});

test("row_details_button_sql_tab (#115): on with result sets (or a run going), soft-disabled with its tooltip without", async () => {
  const user = userEvent.setup();
  render(<TooltipLayer />);
  setup(ws({ activeTabId: "q1" }));
  const details = () => screen.getByRole("button", { name: t.rowDetails });
  // No run: off, its tooltip still shown, a press does nothing.
  await expectSoftDisabled(user, details(), t.rowDetails, () => useChrome.getState().rowDetailsOpen);
  const run = (over: object) =>
    act(() =>
      useQueryRuns.setState({
        runs: { q1: { id: 1, running: false, total: 1, results: [], error: null, cancelled: false, ...over } },
      }),
    );
  // Statements without rows: still off.
  run({ results: [{ index: 0, outcome: { result: null, rowsAffected: 2, elapsedMs: 1 } }] });
  expect(details()).toHaveAttribute("aria-disabled", "true");
  // Running: on (its sets may come).
  run({ running: true });
  expect(details()).not.toHaveAttribute("aria-disabled");
  // A result set: on, it toggles the window's panel.
  run({ results: [{ index: 0, outcome: { result: { columns: [], rows: [], truncated: false }, rowsAffected: null, elapsedMs: 1 } }] });
  expect(details()).not.toHaveAttribute("aria-disabled");
  expect(details()).toHaveAttribute("aria-pressed", "false");
  await user.click(details());
  expect(useChrome.getState().rowDetailsOpen).toBe(true);
  expect(details()).toHaveAttribute("aria-pressed", "true");
  await user.click(details());
  expect(useChrome.getState().rowDetailsOpen).toBe(false);
});
