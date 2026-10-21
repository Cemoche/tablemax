import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { Capabilities } from "../../lib/types";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { SettingsDialog } from "../settings/SettingsDialog";
import { WorkspaceView } from "./WorkspaceView";

/** Elements whose tooltip (#109) is `label`. */
const byTooltip = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-tooltip]")].filter((e) => e.dataset.tooltip === label);

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
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});

test("the empty-workspace hint names the effective new-tab shortcut", () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+Shift+N" } } });
  render(<WorkspaceView workspace={{ ...workspace, tabs: [], activeTabId: null, mru: [] }} />);
  expect(screen.getByText(strings.workspace.noTabsHint("Ctrl+Shift+N"))).toBeInTheDocument();
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

test("Ctrl+W with the Settings dialog open does not close the tab", () => {
  vi.mocked(ipc.appVersion).mockResolvedValue("1.2.3");
  render(<SettingsDialog onClose={() => {}} />);
  press({ code: "KeyW" });
  press({ code: "KeyT" });
  expect(tabs()).toHaveLength(1);
});

test("a custom new-tab combination opens a tab and the default no longer does", () => {
  act(() =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+Shift+N" } } }),
  );
  press({ code: "KeyT" });
  expect(tabs()).toHaveLength(1);
  press({ code: "KeyN", shiftKey: true });
  expect(tabs()).toHaveLength(2);
});

test("a custom close-tab combination closes the tab; Mod+W no longer does", () => {
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "tab.close": "Mod+F4" } } }));
  press({ code: "KeyW" });
  expect(tabs()).toHaveLength(1);
  press({ code: "F4" });
  expect(tabs()).toHaveLength(0);
});

test("a held Mod+T opens exactly one tab", () => {
  press({ code: "KeyT" });
  for (let i = 0; i < 5; i++) press({ code: "KeyT", repeat: true });
  expect(tabs()).toHaveLength(2);
});

/** Renders the store's workspace and keeps it in sync with the store. */
function renderLive(over: Partial<Workspace>) {
  cleanup();
  useWorkspaces.setState({ workspaces: [{ ...workspace, ...over }], activeWorkspaceId: "w1" });
  const Live = () => {
    const w = useWorkspaces((s) => s.workspaces[0]);
    return w ? <WorkspaceView workspace={w} /> : null;
  };
  render(<Live />);
}

test("a query tab on another database than the workspace shows a database badge", () => {
  renderLive({
    database: "other",
    tabs: [
      { id: "a", kind: "query", title: "Query 1", sql: "", sqlSessionId: "s1", database: "app" },
      { id: "b", kind: "query", title: "Query 2", sql: "", sqlSessionId: "s2", database: "other" },
      { id: "c", kind: "query", title: "Query 3", sql: "", sqlSessionId: null },
    ],
  });
  const badges = byTooltip(strings.workspace.tabDatabase("app"));
  expect(badges).toHaveLength(1);
  expect(badges[0]).toHaveTextContent("app");
  expect(screen.getByRole("tab", { name: /Query 1/ })).toContainElement(badges[0]);
  expect(byTooltip(strings.workspace.tabDatabase("other"))).toEqual([]);
});

test("a workspace notice is shown until dismissed", async () => {
  const notice = strings.session.databaseFallback("dropped", "app");
  renderLive({ notice });
  // The environment banner is a status too: pick the notice by its text.
  expect(screen.getByText(notice)).toHaveAttribute("role", "status");
  await userEvent.click(screen.getByRole("button", { name: strings.workspace.dismissNotice }));
  expect(screen.queryByText(notice)).toBeNull();
  expect(useWorkspaces.getState().workspaces[0].notice).toBeNull();
});

/** A connection without SQL (e.g. a document database). */
const NO_SQL: Capabilities = {
  sqlEditor: false,
  gridEditing: false,
  routines: false,
  ddl: false,
  foreignKeys: false,
  documents: true,
  databaseSwitch: false,
};

test("without the SQL editor capability there is no new SQL tab: no button, no Mod+T", () => {
  renderLive({ capabilities: NO_SQL, tabs: [], activeTabId: null, mru: [] });
  expect(screen.queryByRole("button", { name: strings.sidebar.newQuery })).toBeNull();
  press({ code: "KeyT" });
  expect(tabs()).toHaveLength(0);
});

test("with the SQL capabilities the sidebar's new SQL tab button and Mod+T stay", async () => {
  renderLive({ capabilities: { ...NO_SQL, sqlEditor: true, documents: false }, tabs: [], activeTabId: null, mru: [] });
  press({ code: "KeyT" });
  expect(tabs()).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: strings.sidebar.newQuery }));
  expect(tabs()).toHaveLength(2);
});

test("Mod+E opens the SQL editor in a new SQL tab", () => {
  press({ code: "KeyE" });
  expect(tabs()).toHaveLength(2);
  expect(tabs()[1].kind).toBe("query");
});

test("no environment banner above the workspace (the status pill shows it)", () => {
  expect(screen.queryByRole("status", { name: "Environment" })).toBeNull();
});

// ---- Task 4: tab shortcuts (spec §5.3) ----

const three = () =>
  renderLive({
    tabs: [
      { id: "a", kind: "query", title: "Query 1", sql: "", sqlSessionId: null },
      { id: "b", kind: "query", title: "Query 2", sql: "", sqlSessionId: null },
      { id: "c", kind: "query", title: "Query 3", sql: "", sqlSessionId: null },
    ],
    activeTabId: "a",
    mru: ["a", "c", "b"],
  });
const activeId = () => useWorkspaces.getState().workspaces[0].activeTabId;

test("ctrl_brackets_and_pageup_cycle_tabs: Ctrl+] / Ctrl+[ and Ctrl+PageDown / PageUp move in bar order", () => {
  three();
  press({ code: "BracketRight" });
  expect(activeId()).toBe("b");
  press({ code: "PageDown" });
  expect(activeId()).toBe("c");
  press({ code: "BracketRight" });
  expect(activeId()).toBe("a");
  press({ code: "BracketLeft" });
  expect(activeId()).toBe("c");
  press({ code: "PageUp" });
  expect(activeId()).toBe("b");
  // Ctrl+Shift+[ stays the previous workspace: the tab does not move.
  press({ code: "BracketLeft", shiftKey: true });
  expect(activeId()).toBe("b");
});

test("Ctrl+Tab keeps the most-recent order, Ctrl+] the bar order", () => {
  three();
  // MRU is a, c, b: Ctrl+Tab then releasing Ctrl goes to c (the bar order would give b).
  press({ code: "Tab" });
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft" }));
  });
  expect(activeId()).toBe("c");
});

test("a custom Next tab combination replaces Ctrl+] and Ctrl+PageDown too", () => {
  three();
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "tab.next": "Alt+N" } } }));
  press({ code: "BracketRight" });
  press({ code: "PageDown" });
  expect(activeId()).toBe("a");
});

test("ctrl_number_goes_to_tab: Ctrl+1…9 activate that tab; past the last, nothing", () => {
  three();
  press({ code: "Digit3" });
  expect(activeId()).toBe("c");
  press({ code: "Digit1" });
  expect(activeId()).toBe("a");
  press({ code: "Digit2" });
  expect(activeId()).toBe("b");
  press({ code: "Digit9" });
  expect(activeId()).toBe("b");
});

test("Alt+← / Alt+→ go back and forward in the workspace's tab history, not while typing", async () => {
  three();
  press({ code: "Digit3" });
  press({ code: "ArrowLeft", ctrlKey: false, altKey: true });
  expect(activeId()).toBe("a");
  press({ code: "ArrowRight", ctrlKey: false, altKey: true });
  expect(activeId()).toBe("c");
  const field = document.createElement("input");
  document.body.appendChild(field);
  field.focus();
  act(() => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ArrowLeft", key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(activeId()).toBe("c");
});

test("the active tab controls the tab content, a tabpanel named by the tab (Task 11)", () => {
  const tab = screen.getByRole("tab", { name: "Query 1" });
  const panel = screen.getByRole("tabpanel", { name: "Query 1" });
  expect(tab).toHaveAttribute("aria-controls", panel.id);
  expect(panel).toHaveAttribute("data-tab-content");
});

test("with no tab the content is no tabpanel", () => {
  cleanup();
  render(<WorkspaceView workspace={{ ...workspace, tabs: [], activeTabId: null, mru: [] }} />);
  const content = screen.getByLabelText(strings.workspace.tabContentLabel);
  expect(content).toHaveAttribute("data-tab-content");
  expect(content).not.toHaveAttribute("role");
  expect(content).not.toHaveAttribute("aria-labelledby");
});
