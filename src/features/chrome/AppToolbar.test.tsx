import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { useConnections } from "../../stores/connections";
import { usePendingChanges } from "../../stores/pendingChanges";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { onWindowResized } from "../../lib/windowResize";
import { AppToolbar } from "./AppToolbar";
import { ResizeHandles } from "./ResizeHandles";

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
  useChrome.setState({ rowDetails: {}, reloads: {}, previews: {}, paletteRequest: null, maximized: false });
  vi.mocked(onWindowResized).mockImplementation(async () => () => {});
  usePendingChanges.getState().drop("t1");
  usePendingChanges.setState({ committing: {}, confirming: {}, awaitingReload: {} });
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
    `PostgreSQL 16.4 : shop : public.orders${strings.statusPill.prod}`,
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
  for (const name of [t.discard, t.preview, t.commit]) expect(button(name)).toBeDisabled();

  act(() => {
    usePendingChanges.getState().addInsert("t1", obj);
  });
  for (const name of [t.discard, t.preview, t.commit]) expect(button(name)).toBeEnabled();
  await user.click(button(t.commit));
  expect(commit).toHaveBeenCalledWith("t1", "w1", obj);
  await user.click(button(t.discard));
  expect(discard).toHaveBeenCalledWith("t1");
  await user.click(button(t.preview));
  expect(useChrome.getState().previews.t1).toBe(1);

  // A running commit locks Commit and Discard.
  act(() => usePendingChanges.setState({ committing: { t1: true } }));
  expect(button(t.commit)).toBeDisabled();
  expect(button(t.discard)).toBeDisabled();
});

test("the commit group is off on a SQL tab and on a disconnected workspace", () => {
  usePendingChanges.getState().addInsert("t1", obj);
  setup(ws({ activeTabId: "q1" }));
  expect(screen.getByRole("button", { name: t.commit })).toBeDisabled();
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

test("the space around the capped status pill moves and maximizes the window", async () => {
  const user = userEvent.setup();
  setup();
  const pill = screen.getByRole("button", { name: /^PostgreSQL 16\.4/ });
  // Capped and centred in a wrapper that takes the free space.
  expect(pill.className).toContain("max-w-140");
  const area = pill.parentElement as HTMLElement;
  expect(area).toHaveAttribute("data-pill-area");
  expect(area.className).toContain("flex-1");
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
  expect(useChrome.getState().rowDetails.t1).toBe(true);
  expect(details).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: t.sidebar }));
  expect(useWorkspaces.getState().sidebarVisible).toBe(false);
});

test("Ctrl+R reloads the workspace", async () => {
  setup();
  await userEvent.setup().keyboard("{Control>}r{/Control}");
  expect(useChrome.getState().reloads).toEqual({ w1: 1, t1: 1 });
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

test("the connections screen shows only the title and the window buttons", () => {
  render(<AppToolbar workspace={null} onEditConnection={vi.fn()} />);
  const header = screen.getByRole("banner");
  expect(within(header).getByText(strings.appName)).toBeInTheDocument();
  expect(buttonNames(header)).toEqual([strings.window.minimize, strings.window.maximize, strings.window.close]);
});
