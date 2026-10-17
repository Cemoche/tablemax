import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { HistoryEntry } from "../../lib/types";
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = (entries: HistoryEntry[] = [entry({})]) => {
  vi.mocked(ipc.historyList).mockResolvedValue(entries);
  vi.mocked(ipc.historyClear).mockResolvedValue(undefined);
  const onInsert = vi.fn();
  const onReplace = vi.fn();
  const r = render(
    <HistoryPanel connectionId="c1" connectionName="Local" onInsert={onInsert} onReplace={onReplace} />,
  );
  return { ...r, onInsert, onReplace };
};

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
  expect(err).toHaveClass("text-danger");
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

test("click inserts the SQL, double-click replaces the editor content", async () => {
  const { onInsert, onReplace } = setup([entry({ sql: "select 42" })]);
  const item = await screen.findByRole("button", { name: /select 42/ });
  await userEvent.click(item);
  await waitFor(() => expect(onInsert).toHaveBeenCalledWith("select 42"));
  expect(onReplace).not.toHaveBeenCalled();
  onInsert.mockClear();
  await userEvent.dblClick(item);
  expect(onReplace).toHaveBeenCalledWith("select 42");
  // The clicks of the double-click do not also insert.
  await act(() => new Promise((r) => setTimeout(r, 400)));
  expect(onInsert).not.toHaveBeenCalled();
});

test("Enter on an entry inserts at once", async () => {
  const { onInsert } = setup([entry({ sql: "select 7" })]);
  const item = await screen.findByRole("button", { name: /select 7/ });
  item.focus();
  await userEvent.keyboard("{Enter}");
  expect(onInsert).toHaveBeenCalledWith("select 7");
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

test("a new refreshKey reloads the list (a run just finished)", async () => {
  const { rerender } = setup();
  await waitFor(() => expect(ipc.historyList).toHaveBeenCalledTimes(1));
  rerender(
    <HistoryPanel connectionId="c1" connectionName="Local" refreshKey={1} onInsert={vi.fn()} onReplace={vi.fn()} />,
  );
  await waitFor(() => expect(ipc.historyList).toHaveBeenCalledTimes(2));
});

test("a failed load shows an error", async () => {
  vi.mocked(ipc.historyList).mockRejectedValue({ kind: "io", message: "disk" });
  render(<HistoryPanel connectionId="c1" connectionName="Local" onInsert={vi.fn()} onReplace={vi.fn()} />);
  expect(await screen.findByText(strings.history.loadFailed)).toBeInTheDocument();
});
