import { beforeEach, expect, test } from "vitest";
import { useQueryRuns } from "./queryRuns";

const rs = { columns: [{ name: "a", typeName: "int" }], rows: [] };
const run = () => useQueryRuns.getState().runs.t1;
const ev = (e: Parameters<ReturnType<typeof useQueryRuns.getState>["applyEvent"]>[1]) =>
  useQueryRuns.getState().applyEvent("t1", e);

beforeEach(() => useQueryRuns.setState({ runs: {} }));

test("start marks the tab running and clears old results", () => {
  useQueryRuns.getState().start("t1", 2);
  expect(run()).toMatchObject({ running: true, total: 2, results: [], error: null });
});

test("events accumulate results, then error with index, then finish", () => {
  useQueryRuns.getState().start("t1", 3);
  ev({ event: "statementStarted", data: { index: 0 } });
  ev({
    event: "statementFinished",
    data: { index: 0, outcome: { result: rs, rowsAffected: null, elapsedMs: 5 } },
  });
  ev({ event: "statementStarted", data: { index: 1 } });
  ev({
    event: "statementFinished",
    data: { index: 1, outcome: { result: null, rowsAffected: 4, elapsedMs: 2 } },
  });
  ev({ event: "statementFailed", data: { index: 2, error: { kind: "query", message: "boom" } } });
  expect(run().running).toBe(true);
  ev({ event: "batchFinished", data: { cancelled: false } });
  expect(run()).toMatchObject({
    running: false,
    cancelled: false,
    error: { index: 2, message: "boom" },
  });
  expect(run().results.map((r) => [r.index, r.outcome.rowsAffected])).toEqual([
    [0, null],
    [1, 4],
  ]);
});

test("cancelled flag is recorded", () => {
  useQueryRuns.getState().start("t1", 1);
  ev({ event: "batchFinished", data: { cancelled: true } });
  expect(run()).toMatchObject({ running: false, cancelled: true });
});

test("preflight failure stops running with an index-less error", () => {
  useQueryRuns.getState().start("t1", 1);
  useQueryRuns.getState().preflightFailed("t1", { kind: "invalid", message: "a query is already running" });
  expect(run()).toMatchObject({
    running: false,
    error: { index: null, message: "a query is already running" },
  });
});

test("preflight failure does not clobber a batch that already finished", () => {
  useQueryRuns.getState().start("t1", 1);
  ev({ event: "batchFinished", data: { cancelled: false } });
  useQueryRuns.getState().preflightFailed("t1", { kind: "io", message: "late" });
  expect(run().error).toBeNull();
});

test("drop removes the run", () => {
  useQueryRuns.getState().start("t1", 1);
  useQueryRuns.getState().drop("t1");
  expect(run()).toBeUndefined();
});
