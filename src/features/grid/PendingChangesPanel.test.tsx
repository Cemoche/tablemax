import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { CellValue, RowKey } from "../../lib/types";
import { usePendingChanges } from "../../stores/pendingChanges";
import { PendingChangesPanel } from "./PendingChangesPanel";

vi.mock("../../lib/ipc");

const obj = { schema: "public", name: "order_lines" };
const int = (v: number): CellValue => ({ t: "int", v });
const names = ["order_id", "line", "note", "qty"];
const row = (line: number): CellValue[] => [int(42), int(line), { t: "text", v: `n${line}` }, int(1)];
const key = (line: number): RowKey => [
  ["order_id", int(42)],
  ["line", int(line)],
];
const pending = () => usePendingChanges.getState();
const text = (v: string) => ({ t: "text" as const, v });

const SQL = [
  `UPDATE "order_lines" SET "note" = 'x', "qty" = '2' WHERE "order_id" = 42 AND "line" = 1;`,
  `INSERT INTO "order_lines" ("note") VALUES ('new');`,
  `DELETE FROM "order_lines" WHERE "order_id" = 42 AND "line" = 2;`,
];

/** An update (2 columns), an insert and a delete, in that order. */
function threeChanges() {
  pending().setCell("t1", obj, key(1), "note", text("x"), row(1), names);
  pending().setCell("t1", obj, key(1), "qty", text("2"), row(1), names);
  pending().addInsert("t1", obj, { note: text("new") });
  pending().toggleDelete("t1", obj, key(2));
}

const items = () => within(screen.getByRole("list", { name: strings.grid.changes.label })).getAllByRole("listitem");

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
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
});

test("lists each change with its kind, key, columns and SQL", async () => {
  vi.mocked(ipc.changesPreview).mockResolvedValue(SQL);
  threeChanges();
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  expect(screen.getByRole("button", { name: strings.grid.changes.title(3) })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const [u, i, d] = items();
  expect(u).toHaveTextContent(strings.grid.changes.update);
  expect(u).toHaveTextContent("order_id = 42, line = 1");
  expect(u).toHaveTextContent("note, qty");
  expect(i).toHaveTextContent(strings.grid.changes.insert);
  expect(i).toHaveTextContent(strings.grid.changes.newRow);
  expect(i).toHaveTextContent("note");
  expect(d).toHaveTextContent(strings.grid.changes.delete);
  expect(d).toHaveTextContent("order_id = 42, line = 2");
  expect(await within(u).findByText(SQL[0])).toBeInTheDocument();
  expect(within(i).getByText(SQL[1])).toBeInTheDocument();
  expect(within(d).getByText(SQL[2])).toBeInTheDocument();
  expect(ipc.changesPreview).toHaveBeenCalledTimes(1);
  expect(ipc.changesPreview).toHaveBeenCalledWith("w1", obj, pending().toChanges("t1"));
});

test("Undo reverts one change and reloads the preview", async () => {
  vi.mocked(ipc.changesPreview).mockResolvedValueOnce(SQL).mockResolvedValue([SQL[0], SQL[2]]);
  threeChanges();
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  await screen.findByText(SQL[1]);
  await userEvent.click(screen.getByRole("button", { name: strings.grid.changes.undoLabel(2) }));
  expect(pending().count("t1")).toBe(2);
  expect(pending().tabs.t1.inserts).toEqual([]);
  await waitFor(() => expect(ipc.changesPreview).toHaveBeenCalledTimes(2));
  expect(vi.mocked(ipc.changesPreview).mock.calls[1][2]).toEqual(pending().toChanges("t1"));
  await waitFor(() => expect(screen.queryByText(SQL[1])).toBeNull());
  expect(items()).toHaveLength(2);
  expect(items()[1]).toHaveTextContent(SQL[2]);
});

test("the apply error shows on the failed change (failedIndex)", async () => {
  vi.mocked(ipc.changesPreview).mockResolvedValue(SQL);
  vi.mocked(ipc.changesApply).mockResolvedValue({
    applied: false,
    affected: [1, 0],
    failedIndex: 1,
    error: { kind: "query", message: "duplicate key value" },
  });
  threeChanges();
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  await act(() => pending().commit("t1", "w1", obj));
  const [u, i, d] = items();
  expect(within(i).getByText("duplicate key value")).toBeInTheDocument();
  expect(u).not.toHaveTextContent("duplicate key value");
  expect(d).not.toHaveTextContent("duplicate key value");
});

test("an Invalid preview shows on the change it names", async () => {
  vi.mocked(ipc.changesPreview).mockRejectedValue({
    kind: "invalid",
    message: "change 2: unknown column \"nope\"",
  });
  threeChanges();
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  const [u, , d] = items();
  expect(await within(d).findByText('unknown column "nope"')).toBeInTheDocument();
  expect(u).not.toHaveTextContent("unknown column");
});

test("the preview waits 200 ms after the last change and ignores stale answers", async () => {
  const first = deferred<string[]>();
  vi.mocked(ipc.changesPreview).mockReturnValueOnce(first.promise).mockResolvedValue(["NEW SQL"]);
  pending().toggleDelete("t1", obj, key(1));
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  await waitFor(() => expect(ipc.changesPreview).toHaveBeenCalledTimes(1));
  // Two quick changes while the first preview is in flight: one more call, not two.
  act(() => {
    pending().toggleDelete("t1", obj, key(1));
    pending().toggleDelete("t1", obj, key(3));
  });
  expect(ipc.changesPreview).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("NEW SQL")).toBeInTheDocument();
  expect(ipc.changesPreview).toHaveBeenCalledTimes(2);
  await act(async () => first.resolve(["OLD SQL"]));
  expect(screen.queryByText("OLD SQL")).toBeNull();
  expect(screen.getByText("NEW SQL")).toBeInTheDocument();
});

test("collapses, hides when nothing is pending and opens again on the next change", async () => {
  vi.mocked(ipc.changesPreview).mockResolvedValue(["SQL 1"]);
  pending().toggleDelete("t1", obj, key(1));
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  await screen.findByText("SQL 1");
  const header = screen.getByRole("button", { name: strings.grid.changes.title(1) });
  await userEvent.click(header);
  expect(header).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("SQL 1")).toBeNull();
  act(() => void pending().discard("t1"));
  expect(screen.queryByRole("button", { name: /Pending changes/ })).toBeNull();
  act(() => void pending().toggleDelete("t1", obj, key(1)));
  expect(screen.getByRole("button", { name: strings.grid.changes.title(1) })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

test("Undo is disabled while a commit runs", async () => {
  vi.mocked(ipc.changesPreview).mockResolvedValue(["SQL 1"]);
  const apply = deferred<Awaited<ReturnType<typeof ipc.changesApply>>>();
  vi.mocked(ipc.changesApply).mockReturnValue(apply.promise);
  pending().toggleDelete("t1", obj, key(1));
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  let done: Promise<boolean> = Promise.resolve(true);
  act(() => {
    done = pending().commit("t1", "w1", obj);
  });
  expect(screen.getByRole("button", { name: strings.grid.changes.undoLabel(1) })).toBeDisabled();
  await act(async () => {
    apply.resolve({ applied: true, affected: [1], failedIndex: null, error: null });
    await done;
  });
});

test("a changed line hides its old SQL until the new preview arrives", async () => {
  const second = deferred<string[]>();
  vi.mocked(ipc.changesPreview)
    .mockResolvedValueOnce(["OLD UPDATE", "DELETE 2"])
    .mockReturnValueOnce(second.promise);
  pending().setCell("t1", obj, key(1), "note", text("x"), row(1), names);
  pending().toggleDelete("t1", obj, key(2));
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  await screen.findByText("OLD UPDATE");
  act(() => void pending().setCell("t1", obj, key(1), "qty", text("9"), row(1), names));
  // The update changed: its SQL is stale; the delete did not.
  expect(screen.queryByText("OLD UPDATE")).toBeNull();
  expect(screen.getByText("DELETE 2")).toBeInTheDocument();
  await waitFor(() => expect(ipc.changesPreview).toHaveBeenCalledTimes(2));
  await act(async () => second.resolve(["NEW UPDATE", "DELETE 2"]));
  expect(screen.getByText("NEW UPDATE")).toBeInTheDocument();
});

test("text key values are quoted", () => {
  vi.mocked(ipc.changesPreview).mockResolvedValue([]);
  pending().toggleDelete("t1", obj, [
    ["name", { t: "text", v: "O'Brien, a" }],
    ["n", int(3)],
  ]);
  render(<PendingChangesPanel workspaceId="w1" tabId="t1" object={obj} />);
  expect(items()[0]).toHaveTextContent("name = 'O''Brien, a', n = 3");
});
