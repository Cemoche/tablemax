import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { HistoryEntry } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { HISTORY_LIMIT, HistoryPanel, relativeTime } from "./HistoryPanel";

vi.mock("../../lib/ipc");

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: 1,
  connectionId: "c1",
  sql: "select 1",
  executedAt: NOW - 2 * 60_000,
  elapsedMs: 12,
  rows: 3,
  error: null,
  ...over,
});

const workspace: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "Local",
  color: "swatch-1",
  envTag: "dev",
  dialect: "postgres",
  status: "connected",
  database: null,
  schemas: ["public"],
  currentSchema: "public",
  tabs: [],
  activeTabId: null,
  mru: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
  useChrome.setState({ historyBumps: {}, runRequests: {}, editorInserts: {} });
});

const tabs = () => useWorkspaces.getState().workspaces[0].tabs;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = (entries: HistoryEntry[] = [entry({})]) => {
  vi.mocked(ipc.historyList).mockResolvedValue(entries);
  vi.mocked(ipc.historyClear).mockResolvedValue(undefined);
  vi.mocked(ipc.historyDelete).mockResolvedValue(undefined);
  return render(<HistoryPanel workspace={workspace} />);
};

const openMenu = async (sql: RegExp) => {
  fireEvent.contextMenu(await screen.findByRole("button", { name: sql }));
  return screen.findByRole("menu", { name: strings.history.menuLabel });
};
const Q = strings.sqlMenu;

test("lists the connection's history with relative date, duration, rows and errors", async () => {
  setup([
    entry({ id: 2, sql: "select 2", executedAt: NOW - 30_000, elapsedMs: 5, rows: 1 }),
    entry({ id: 1, sql: "select boom", error: "relation boom missing", rows: null }),
  ]);
  await waitFor(() => expect(ipc.historyList).toHaveBeenCalledWith("c1", null, HISTORY_LIMIT));
  expect(HISTORY_LIMIT).toBe(200);
  const items = await screen.findAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByText("select 2")).toBeInTheDocument();
  expect(within(items[0]).getByText(relativeTime(NOW - 30_000, NOW))).toBeInTheDocument();
  expect(within(items[0]).getByText(strings.history.duration(5))).toBeInTheDocument();
  expect(within(items[0]).getByText(strings.history.rows(1))).toBeInTheDocument();
  const err = within(items[1]).getByText("relation boom missing");
  expect(err).toHaveClass("text-danger-text");
  expect(within(items[1]).getByText(relativeTime(NOW - 120_000, NOW))).toBeInTheDocument();
});

test("relative dates read naturally", () => {
  expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe("2 minutes ago");
  expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
  expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2 days ago");
  expect(relativeTime(NOW - 1000, NOW)).toBe("now");
});

test("the search box is debounced and passed to historyList", async () => {
  setup();
  await waitFor(() => expect(ipc.historyList).toHaveBeenCalledTimes(1));
  await userEvent.type(screen.getByRole("searchbox", { name: strings.history.search }), "users");
  await waitFor(() => expect(ipc.historyList).toHaveBeenLastCalledWith("c1", "users", HISTORY_LIMIT));
  // One request for the whole word, not one per keystroke.
  expect(vi.mocked(ipc.historyList).mock.calls.length).toBeLessThanOrEqual(3);
});

test("query_click_opens_sql_tab: a click opens a new SQL tab with the entry's text", async () => {
  setup([entry({ sql: "select 42" })]);
  await userEvent.click(await screen.findByRole("button", { name: /select 42/ }));
  expect(tabs()).toEqual([expect.objectContaining({ kind: "query", sql: "select 42" })]);
  expect(useWorkspaces.getState().workspaces[0].activeTabId).toBe(tabs()[0].id);
});

test("Enter on an entry opens it too", async () => {
  setup([entry({ sql: "select 7" })]);
  (await screen.findByRole("button", { name: /select 7/ })).focus();
  await userEvent.keyboard("{Enter}");
  expect(tabs()).toEqual([expect.objectContaining({ kind: "query", sql: "select 7" })]);
});

test("the menu: Run, Copy, Insert into SQL editor, Delete", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  setup([entry({ id: 5, sql: "select 5" })]);
  const menu = await openMenu(/select 5/);
  expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
    Q.run,
    Q.copy,
    Q.insert,
    Q.delete,
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: Q.copy }));
  expect(writeText).toHaveBeenCalledWith("select 5");

  // Run: a new SQL tab with the text, asked to run.
  await userEvent.click(within(await openMenu(/select 5/)).getByRole("menuitem", { name: Q.run }));
  expect(tabs()).toHaveLength(1);
  expect(useChrome.getState().runRequests[tabs()[0].id]).toBe(1);

  // Insert: into the active SQL tab, no new tab.
  await userEvent.click(within(await openMenu(/select 5/)).getByRole("menuitem", { name: Q.insert }));
  expect(tabs()).toHaveLength(1);
  expect(useChrome.getState().editorInserts[tabs()[0].id]).toBe("select 5");

  vi.mocked(ipc.historyList).mockResolvedValue([]);
  await userEvent.click(within(await openMenu(/select 5/)).getByRole("menuitem", { name: Q.delete }));
  expect(ipc.historyDelete).toHaveBeenCalledWith("c1", 5);
  expect(await screen.findByText(strings.history.empty)).toBeInTheDocument();
});

test("Insert without a SQL tab opens one with the text", async () => {
  setup([entry({ sql: "select 9" })]);
  await userEvent.click(within(await openMenu(/select 9/)).getByRole("menuitem", { name: Q.insert }));
  expect(tabs()).toEqual([expect.objectContaining({ kind: "query", sql: "select 9" })]);
});

test("a failed delete is reported", async () => {
  setup([entry({ id: 5, sql: "select 5" })]);
  vi.mocked(ipc.historyDelete).mockRejectedValue({ kind: "io", message: "disk" });
  await userEvent.click(within(await openMenu(/select 5/)).getByRole("menuitem", { name: Q.delete }));
  expect(await screen.findByText(strings.history.deleteFailed)).toBeInTheDocument();
});

test("Clear history asks for confirmation, then clears and reloads", async () => {
  setup();
  await screen.findAllByRole("listitem");
  await userEvent.click(screen.getByRole("button", { name: strings.history.clear }));
  const dialog = screen.getByRole("alertdialog", { name: strings.history.clearTitle });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  // Cancel keeps everything.
  await userEvent.click(within(dialog).getByRole("button", { name: strings.history.cancel }));
  expect(ipc.historyClear).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: strings.history.clear }));
  vi.mocked(ipc.historyList).mockResolvedValue([]);
  await userEvent.click(screen.getByRole("button", { name: strings.history.clearConfirm }));
  expect(ipc.historyClear).toHaveBeenCalledWith("c1");
  expect(await screen.findByText(strings.history.empty)).toBeInTheDocument();
});

test("Escape closes the confirmation without clearing", async () => {
  setup();
  await screen.findAllByRole("listitem");
  await userEvent.click(screen.getByRole("button", { name: strings.history.clear }));
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(ipc.historyClear).not.toHaveBeenCalled();
});

test("a run that finished on the connection reloads the list", async () => {
  setup();
  await waitFor(() => expect(ipc.historyList).toHaveBeenCalledTimes(1));
  act(() => useChrome.getState().bumpHistory("c1"));
  await waitFor(() => expect(ipc.historyList).toHaveBeenCalledTimes(2));
  // Another connection's runs are not ours.
  act(() => useChrome.getState().bumpHistory("c2"));
  await act(async () => {});
  expect(ipc.historyList).toHaveBeenCalledTimes(2);
});

test("a failed load shows an error", async () => {
  vi.mocked(ipc.historyList).mockRejectedValue({ kind: "io", message: "disk" });
  render(<HistoryPanel workspace={workspace} />);
  expect(await screen.findByText(strings.history.loadFailed)).toBeInTheDocument();
});

test("the menu gives the focus back to its entry on Escape or a press outside", async () => {
  setup([entry({ sql: "select 5" })]);
  await openMenu(/select 5/);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: /select 5/ })).toHaveFocus();
  await openMenu(/select 5/);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: /select 5/ })).toHaveFocus());
});

test("a press outside on something that takes the focus leaves the focus there", async () => {
  vi.mocked(ipc.historyList).mockResolvedValue([entry({ sql: "select 5" })]);
  render(
    <>
      <HistoryPanel workspace={workspace} />
      <input
        aria-label="editor stand-in"
        onMouseDown={(e) => {
          e.preventDefault();
          e.currentTarget.focus();
        }}
      />
    </>,
  );
  await openMenu(/select 5/);
  const editor = screen.getByRole("textbox", { name: "editor stand-in" });
  fireEvent.mouseDown(editor);
  expect(screen.queryByRole("menu")).toBeNull();
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(editor).toHaveFocus();
});

test("Copy without a clipboard reports the failure", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  setup([entry({ sql: "select 5" })]);
  await userEvent.click(within(await openMenu(/select 5/)).getByRole("menuitem", { name: Q.copy }));
  expect(await screen.findByText(strings.history.copyFailed)).toBeInTheDocument();
});

test("Clear history has a visible focus ring", async () => {
  setup();
  const clear = await screen.findByRole("button", { name: strings.history.clear });
  expect(clear).toHaveClass("focus-visible:outline-2", "focus-visible:outline-solid", "focus-visible:outline-accent");
});
