import { beforeEach, expect, test, vi } from "vitest";
import { insertValuesOf } from "../features/grid/editing";
import * as ipc from "../lib/ipc";
import { strings } from "../lib/strings";
import type { CellValue, RowKey } from "../lib/types";
import { tableInfo } from "../test/tableInfo";
import { guardPending, rowKeyId, usePendingChanges } from "./pendingChanges";

vi.mock("../lib/ipc");

const T = "tab1";
const columns = ["id", "order_id", "line", "note", "total", "data"];
const int = (v: number): CellValue => ({ t: "int", v });
const row = (line: number, note: string): CellValue[] => [
  int(100 + line),
  int(42),
  int(line),
  { t: "text", v: note },
  { t: "decimal", v: "1.50" },
  { t: "null" },
];
const key = (line: number): RowKey => [
  ["order_id", int(42)],
  ["line", int(line)],
];
const s = () => usePendingChanges.getState();
const obj = { schema: "public", name: "order_lines" };

beforeEach(() => {
  vi.resetAllMocks();
  usePendingChanges.setState({ tabs: {}, blocked: {}, committing: {}, applied: {}, editorOpen: {} });
});

test("setting a cell back to its original value removes the edit", () => {
  s().setCell(T, obj, key(1), "note", { t: "text", v: "new" }, row(1, "old"), columns);
  expect(s().count(T)).toBe(1);
  s().setCell(T, obj, key(1), "note", { t: "text", v: "old" }, row(1, "old"), columns);
  expect(s().count(T)).toBe(0);
  expect(s().tabs[T].edits).toEqual({});
  // Two columns, one reverted: the other stays.
  s().setCell(T, obj, key(1), "note", { t: "null" }, row(1, "old"), columns);
  s().setCell(T, obj, key(1), "line", { t: "text", v: "9" }, row(1, "old"), columns);
  s().revertCell(T, key(1), "note");
  expect(s().tabs[T].edits[rowKeyId(key(1))].set).toEqual({ line: { t: "text", v: "9" } });
});

test("duplicating a row leaves out auto and generated columns", () => {
  const { values } = insertValuesOf(tableInfo(), columns, row(1, "copy me"));
  const tempId = s().addInsert(T, obj, values);
  expect(s().tabs[T].inserts).toEqual([
    {
      tempId,
      values: {
        order_id: { t: "text", v: "42" },
        line: { t: "text", v: "1" },
        note: { t: "text", v: "copy me" },
      },
    },
  ]);
  expect(s().toChanges(T)[0]).toEqual({
    kind: "insert",
    values: [
      ["order_id", { t: "text", v: "42" }],
      ["line", { t: "text", v: "1" }],
      ["note", { t: "text", v: "copy me" }],
    ],
  });
});

test("toChanges lists updates, then inserts, then deletes", () => {
  s().toggleDelete(T, obj, key(3));
  const a = s().addInsert(T, obj)!;
  s().setInsertCell(T, a, "note", { t: "text", v: "fresh" });
  s().setInsertCell(T, a, "line", { t: "default" });
  s().setCell(T, obj, key(1), "note", { t: "null" }, row(1, "old"), columns);
  s().setCell(T, obj, key(2), "note", { t: "text", v: "" }, row(2, "old"), columns);
  expect(s().count(T)).toBe(4);
  expect(s().toChanges(T)).toEqual([
    { kind: "update", key: key(1), set: [["note", { t: "null" }]] },
    { kind: "update", key: key(2), set: [["note", { t: "text", v: "" }]] },
    { kind: "insert", values: [["note", { t: "text", v: "fresh" }]] },
    { kind: "delete", key: key(3) },
  ]);
  expect(s().changeList(T).map((c) => c.id)).toEqual([
    `update:${rowKeyId(key(1))}`,
    `update:${rowKeyId(key(2))}`,
    `insert:${a}`,
    `delete:${rowKeyId(key(3))}`,
  ]);
});

test("deleting an edited row keeps only the delete; restoring it brings nothing back", () => {
  s().setCell(T, obj, key(1), "note", { t: "text", v: "new" }, row(1, "old"), columns);
  s().toggleDelete(T, obj, key(1));
  expect(s().toChanges(T)).toEqual([{ kind: "delete", key: key(1) }]);
  // A deleted row cannot be edited.
  s().setCell(T, obj, key(1), "note", { t: "text", v: "again" }, row(1, "old"), columns);
  expect(s().toChanges(T)).toEqual([{ kind: "delete", key: key(1) }]);
  s().toggleDelete(T, obj, key(1));
  expect(s().count(T)).toBe(0);
});

test("revertChange, removeInsert and discard", () => {
  s().setCell(T, obj, key(1), "note", { t: "text", v: "new" }, row(1, "old"), columns);
  const a = s().addInsert(T, obj)!;
  s().toggleDelete(T, obj, key(2));
  s().revertChange(T, `update:${rowKeyId(key(1))}`);
  s().removeInsert(T, a);
  expect(s().toChanges(T)).toEqual([{ kind: "delete", key: key(2) }]);
  s().discard(T);
  expect(s().count(T)).toBe(0);
  expect(s().count("unknown")).toBe(0);
});

test("guardPending refuses while changes are pending and flags the tab", () => {
  expect(guardPending(T)).toBe(true);
  expect(s().blocked[T]).toBeFalsy();
  s().toggleDelete(T, obj, key(1));
  expect(guardPending(T)).toBe(false);
  expect(s().blocked[T]).toBe(true);
  s().discard(T);
  expect(s().blocked[T]).toBeFalsy();
  expect(guardPending(T)).toBe(true);
});

test("commit applies toChanges, then clears the tab and bumps applied", async () => {
  vi.mocked(ipc.changesApply).mockResolvedValue({
    applied: true,
    affected: [1, 1],
    failedIndex: null,
    error: null,
  });
  s().setCell(T, obj, key(1), "note", { t: "text", v: "new" }, row(1, "old"), columns);
  s().toggleDelete(T, obj, key(2));
  const changes = s().toChanges(T);
  await expect(s().commit(T, "w1", obj)).resolves.toBe(true);
  expect(ipc.changesApply).toHaveBeenCalledWith("w1", obj, changes);
  expect(s().count(T)).toBe(0);
  expect(s().applied[T]).toBe(1);
  expect(s().committing[T]).toBeFalsy();
});

test("a failed change is marked with its message and nothing is removed", async () => {
  vi.mocked(ipc.changesApply).mockResolvedValue({
    applied: false,
    affected: [1, 0],
    failedIndex: 1,
    error: { kind: "query", message: "the row was deleted or its key changed since it was loaded" },
  });
  s().setCell(T, obj, key(1), "note", { t: "text", v: "new" }, row(1, "old"), columns);
  s().toggleDelete(T, obj, key(2));
  await expect(s().commit(T, "w1", obj)).resolves.toBe(false);
  expect(s().count(T)).toBe(2);
  expect(s().tabs[T].errors).toEqual({
    [`delete:${rowKeyId(key(2))}`]: "the row was deleted or its key changed since it was loaded",
  });
  expect(s().applied[T]).toBeUndefined();
  // Touching the failed change clears its error.
  s().toggleDelete(T, obj, key(2));
  expect(s().tabs[T].errors).toEqual({});
});

test("a refused change ('change N: …') and a failed commit are reported", async () => {
  s().setCell(T, obj, key(1), "note", { t: "text", v: "new" }, row(1, "old"), columns);
  vi.mocked(ipc.changesApply).mockRejectedValueOnce({
    kind: "invalid",
    message: "change 0: row has a NULL key: it cannot be edited",
  });
  await s().commit(T, "w1", obj);
  expect(s().tabs[T].errors).toEqual({
    [`update:${rowKeyId(key(1))}`]: "row has a NULL key: it cannot be edited",
  });
  vi.mocked(ipc.changesApply).mockResolvedValueOnce({
    applied: false,
    affected: [1],
    failedIndex: null,
    error: { kind: "query", message: "deferred constraint violated" },
  });
  await s().commit(T, "w1", obj);
  expect(s().tabs[T].errors).toEqual({});
  expect(s().tabs[T].error).toBe("deferred constraint violated");
  vi.mocked(ipc.changesApply).mockRejectedValueOnce({ kind: "cancelled", message: "query cancelled" });
  await s().commit(T, "w1", obj);
  expect(s().tabs[T].error).toBe(strings.grid.commitCancelled);
  expect(s().count(T)).toBe(1);
});

test("a commit finishing after its tab was closed leaves nothing behind", async () => {
  let resolve!: (o: Awaited<ReturnType<typeof ipc.changesApply>>) => void;
  vi.mocked(ipc.changesApply).mockImplementation(() => new Promise((r) => (resolve = r)));
  s().toggleDelete(T, obj, key(1));
  const done = s().commit(T, "w1", obj);
  s().drop(T);
  resolve({ applied: true, affected: [1], failedIndex: null, error: null });
  await done;
  expect(s().tabs[T]).toBeUndefined();
  expect(s().committing[T]).toBeUndefined();
  expect(s().applied[T]).toBeUndefined();
});

test("changes are refused while a commit runs, and a second commit is not sent", async () => {
  let resolve!: (o: Awaited<ReturnType<typeof ipc.changesApply>>) => void;
  vi.mocked(ipc.changesApply).mockImplementation(() => new Promise((r) => (resolve = r)));
  s().toggleDelete(T, obj, key(1));
  const done = s().commit(T, "w1", obj);
  expect(s().setCell(T, obj, key(2), "note", { t: "null" }, row(2, "old"), columns)).toBe(false);
  expect(s().addInsert(T, obj)).toBeNull();
  expect(s().toggleDelete(T, obj, key(3))).toBe(false);
  expect(s().toggleDelete(T, obj, key(1))).toBe(false);
  expect(s().revertChange(T, `delete:${rowKeyId(key(1))}`)).toBe(false);
  expect(s().discard(T)).toBe(false);
  expect(s().toChanges(T)).toEqual([{ kind: "delete", key: key(1) }]);
  await expect(s().commit(T, "w1", obj)).resolves.toBe(false);
  expect(ipc.changesApply).toHaveBeenCalledTimes(1);
  resolve({ applied: true, affected: [1], failedIndex: null, error: null });
  await expect(done).resolves.toBe(true);
  expect(s().count(T)).toBe(0);
  expect(s().setCell(T, obj, key(2), "note", { t: "null" }, row(2, "old"), columns)).toBe(true);
});

test("columns named __proto__ and constructor are ordinary columns", () => {
  const names = ["id", "__proto__", "constructor"];
  const orig: CellValue[] = [int(1), { t: "text", v: "p" }, { t: "text", v: "c" }];
  const k: RowKey = [["id", int(1)]];
  s().setCell(T, obj, k, "__proto__", { t: "text", v: "P" }, orig, names);
  s().setCell(T, obj, k, "constructor", { t: "null" }, orig, names);
  expect(s().toChanges(T)).toEqual([
    { kind: "update", key: k, set: [["__proto__", { t: "text", v: "P" }], ["constructor", { t: "null" }]] },
  ]);
  s().setCell(T, obj, k, "__proto__", { t: "text", v: "p" }, orig, names);
  expect(s().toChanges(T)).toEqual([{ kind: "update", key: k, set: [["constructor", { t: "null" }]] }]);
  const a = s().addInsert(T, obj)!;
  s().setInsertCell(T, a, "constructor", { t: "text", v: "x" });
  s().setInsertCell(T, a, "__proto__", { t: "text", v: "y" });
  expect(s().toChanges(T)[1]).toEqual({
    kind: "insert",
    values: [["constructor", { t: "text", v: "x" }], ["__proto__", { t: "text", v: "y" }]],
  });
  s().setInsertCell(T, a, "constructor", { t: "default" });
  expect(s().toChanges(T)[1]).toEqual({ kind: "insert", values: [["__proto__", { t: "text", v: "y" }]] });
});

test("the editor-open flag is per tab", () => {
  s().setEditorOpen(T, true);
  expect(s().editorOpen[T]).toBe(true);
  s().setEditorOpen(T, false);
  expect(s().editorOpen[T]).toBe(false);
});

test("changes are bound to the table of their first change", async () => {
  const other = { schema: "public", name: "orders" };
  expect(s().addInsert(T, obj)).not.toBeNull();
  expect(s().addInsert(T, other)).toBeNull();
  expect(s().setCell(T, other, key(1), "note", { t: "null" }, row(1, "old"), columns)).toBe(false);
  expect(s().toggleDelete(T, other, key(2))).toBe(false);
  expect(s().count(T)).toBe(1);
  await expect(s().commit(T, "w1", other)).resolves.toBe(false);
  expect(ipc.changesApply).not.toHaveBeenCalled();
  expect(s().tabs[T].error).toBe(strings.grid.otherTableChanges("order_lines"));
  expect(s().count(T)).toBe(1);
  // Once nothing is pending, the tab can take changes for another table.
  s().discard(T);
  expect(s().toggleDelete(T, other, key(2))).toBe(true);
  expect(s().tabs[T].object).toEqual(other);
  s().revertChange(T, `delete:${rowKeyId(key(2))}`);
  expect(s().tabs[T].object).toBeNull();
});
