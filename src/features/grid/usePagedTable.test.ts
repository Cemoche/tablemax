import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import type { ResultSet } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { usePendingChanges } from "../../stores/pendingChanges";
import { formatRowCount, usePagedTable } from "./usePagedTable";

vi.mock("../../lib/ipc");

const obj = { schema: "public", name: "users" };
const rs = (n: number): ResultSet => ({
  columns: [{ name: "id", typeName: "int" }],
  rows: Array.from({ length: n }, (_, i) => [{ t: "int", v: i }]),
  truncated: false,
});

beforeEach(() => {
  vi.resetAllMocks();
  useGridViews.setState({ views: {} });
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
  vi.mocked(ipc.tablePage).mockResolvedValue(rs(3));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 650 });
});

test("sort cycles asc, desc, none and resets page", async () => {
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.rowCount).not.toBeNull());
  act(() => result.current.nextPage());
  expect(result.current.page).toBe(1);
  act(() => result.current.setSort("id"));
  expect(result.current.sort).toEqual(["id", "asc"]);
  expect(result.current.page).toBe(0);
  act(() => result.current.setSort("id"));
  expect(result.current.sort).toEqual(["id", "desc"]);
  act(() => result.current.setSort("id"));
  expect(result.current.sort).toBeNull();
  act(() => result.current.setSort("id"));
  act(() => result.current.setSort("name"));
  expect(result.current.sort).toEqual(["name", "asc"]);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", {
    object: obj,
    limit: 300,
    offset: 0,
    sort: ["name", "asc"],
    filters: [],
    combine: "and",
  });
  expect(ipc.tableCount).toHaveBeenCalledWith("w1", obj, [], "and");
});

test("paging bounds and page count", async () => {
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.pageCount).toBe(3));
  act(() => result.current.prevPage());
  expect(result.current.page).toBe(0);
  act(() => result.current.nextPage());
  act(() => result.current.nextPage());
  act(() => result.current.nextPage());
  expect(result.current.page).toBe(2);
  await waitFor(() => expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 600 })));
});

test("view state survives remount", async () => {
  const a = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(a.result.current.pageCount).toBe(3));
  act(() => a.result.current.nextPage());
  a.unmount();
  const b = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  expect(b.result.current.page).toBe(1);
});

test("stale responses are ignored", async () => {
  let resolveFirst!: (r: ResultSet) => void;
  vi.mocked(ipc.tablePage)
    .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
    .mockResolvedValue(rs(2));
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  act(() => result.current.setSort("id"));
  await waitFor(() => expect(result.current.result?.rows).toHaveLength(2));
  await act(async () => resolveFirst(rs(9)));
  expect(result.current.result?.rows).toHaveLength(2);
});

test("errors surface and reload retries", async () => {
  vi.mocked(ipc.tablePage).mockRejectedValueOnce({ kind: "connectionLost", message: "gone" });
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.error?.kind).toBe("connectionLost"));
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.error).toBeNull());
  expect(result.current.result?.rows).toHaveLength(3);
  expect(ipc.tableCount).toHaveBeenCalledTimes(2);
});

test("estimate count renders with ≈", () => {
  expect(formatRowCount({ t: "estimate", v: 1234567 })).toBe("≈ 1,234,567");
  expect(formatRowCount({ t: "exact", v: 1234567 })).toBe("1,234,567");
  expect(formatRowCount(null)).toBe("…");
});

test("unmounting before the response resolves updates no state", async () => {
  let resolvePage!: (r: ResultSet) => void;
  vi.mocked(ipc.tablePage).mockImplementation(() => new Promise((r) => (resolvePage = r)));
  let resolveCount!: (c: { t: "exact"; v: number }) => void;
  vi.mocked(ipc.tableCount).mockImplementation(() => new Promise((r) => (resolveCount = r)));
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result, unmount } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  unmount();
  await act(async () => {
    resolvePage(rs(3));
    resolveCount({ t: "exact", v: 3 });
  });
  expect(result.current.result).toBeNull();
  expect(result.current.rowCount).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

test("pending changes block paging and sorting", async () => {
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.pageCount).toBe(3));
  act(() => usePendingChanges.getState().addInsert("t1", obj));
  act(() => result.current.reload());
  act(() => result.current.nextPage());
  act(() => result.current.setSort("id"));
  expect(result.current.page).toBe(0);
  expect(result.current.sort).toBeNull();
  expect(usePendingChanges.getState().blocked.t1).toBe(true);
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  act(() => usePendingChanges.getState().discard("t1"));
  act(() => result.current.nextPage());
  expect(result.current.page).toBe(1);
});

test("changed filters restart at page 0 and go to tablePage and tableCount", async () => {
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.pageCount).toBe(3));
  act(() => result.current.nextPage());
  expect(result.current.page).toBe(1);
  const filters = [{ column: "id", op: "gt" as const, values: ["10"] }];
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "exact", v: 12 });
  let applied = false;
  act(() => {
    applied = result.current.setFilters(filters);
  });
  expect(applied).toBe(true);
  expect(result.current.page).toBe(0);
  expect(result.current.filters).toEqual(filters);
  // The count of the previous filters is not shown while the new one loads.
  expect(result.current.rowCount).toBeNull();
  await waitFor(() => expect(result.current.rowCount).toEqual({ t: "exact", v: 12 }));
  expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", {
    object: obj,
    limit: 300,
    offset: 0,
    sort: null,
    filters,
    combine: "and",
  });
  expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", obj, filters, "and");
  expect(useGridViews.getState().getView("t1").filters).toEqual(filters);
});

test("pending changes block a filter change", async () => {
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.pageCount).toBe(3));
  act(() => usePendingChanges.getState().addInsert("t1", obj));
  let applied = true;
  act(() => {
    applied = result.current.setFilters([{ column: "id", op: "eq", values: ["1"] }]);
  });
  expect(applied).toBe(false);
  expect(result.current.filters).toEqual([]);
  expect(usePendingChanges.getState().blocked.t1).toBe(true);
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
  expect(ipc.tableCount).toHaveBeenCalledTimes(1);
});

test("a capped filtered count shows 500,000+ and pages on while pages are full", async () => {
  expect(formatRowCount({ t: "estimate", v: 500000 }, true)).toBe("500,000+");
  expect(formatRowCount({ t: "exact", v: 12 }, true)).toBe("12");
  expect(formatRowCount({ t: "estimate", v: 500000 })).toBe("≈ 500,000");
  vi.mocked(ipc.tablePage).mockResolvedValue(rs(300));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 600 });
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.rowCount).not.toBeNull());
  act(() => result.current.nextPage());
  await waitFor(() => expect(result.current.loading).toBe(false));
  // Past the estimate, a full page still offers the next one.
  expect(result.current.hasNext).toBe(true);
});

test("with an estimate, only a full page offers the next one", async () => {
  // The estimate says 3 pages, but this page is short: it is the last one.
  vi.mocked(ipc.tablePage).mockResolvedValue(rs(120));
  vi.mocked(ipc.tableCount).mockResolvedValue({ t: "estimate", v: 900 });
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.rowCount).not.toBeNull());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.hasNext).toBe(false);
});

test("a page loaded after a commit settles it; a reload is allowed when the outcome is unknown", async () => {
  const st = usePendingChanges.getState;
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.loading).toBe(false));
  // A commit ended with an unknown outcome: the changes stay pending.
  usePendingChanges.setState((s) => ({
    tabs: {
      ...s.tabs,
      t1: {
        edits: {},
        inserts: [{ tempId: "n1", values: {} }],
        deletes: {},
        errors: {},
        error: "lost",
        refusal: null,
        outcomeUnknown: true,
        object: obj,
      },
    },
    epoch: { t1: 1 },
  }));
  act(() => result.current.reload());
  await waitFor(() => expect(ipc.tablePage).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(st().tabs.t1.outcomeUnknown).toBe(false));
  expect(st().count("t1")).toBe(1);
  // Now a reload is refused again like paging.
  act(() => result.current.reload());
  expect(st().blocked.t1).toBe(true);
  expect(ipc.tablePage).toHaveBeenCalledTimes(2);
});

test("apply_all_and_or: filters joined by OR go to tablePage and tableCount, kept in the view", async () => {
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.rowCount).not.toBeNull());
  const filters = [
    { column: "id", op: "eq" as const, values: ["1"] },
    { column: "id", op: "eq" as const, values: ["2"] },
  ];
  act(() => {
    result.current.setFilters(filters, "or");
  });
  expect(result.current.combine).toBe("or");
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ filters, combine: "or" })),
  );
  expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", obj, filters, "or");
  expect(useGridViews.getState().getView("t1").combine).toBe("or");
  // The same filters joined by AND again are another request (and another count).
  vi.mocked(ipc.tableCount).mockClear();
  act(() => {
    result.current.setFilters(filters);
  });
  expect(result.current.combine).toBe("and");
  await waitFor(() => expect(ipc.tableCount).toHaveBeenLastCalledWith("w1", obj, filters, "and"));
});

test("page_popover_offset_limit: goTo sets the offset and the limit; paging steps from there", async () => {
  vi.mocked(ipc.tablePage).mockResolvedValue(rs(100));
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.rowCount).not.toBeNull());
  expect(result.current.hasPrev).toBe(false);
  let ok = false;
  act(() => {
    ok = result.current.goTo(250, 100);
  });
  expect(ok).toBe(true);
  expect(result.current.offset).toBe(250);
  expect(result.current.pageSize).toBe(100);
  await waitFor(() =>
    expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ offset: 250, limit: 100 })),
  );
  expect(result.current.hasPrev).toBe(true);
  act(() => result.current.nextPage());
  expect(result.current.offset).toBe(350);
  act(() => result.current.prevPage());
  act(() => result.current.prevPage());
  expect(result.current.offset).toBe(150);
  // Back from an offset below one page: the first row.
  act(() => result.current.prevPage());
  expect(result.current.offset).toBe(50);
  act(() => result.current.prevPage());
  expect(result.current.offset).toBe(0);
  expect(result.current.hasPrev).toBe(false);
  // 650 rows from offset 600 by 100: the last page.
  act(() => {
    result.current.goTo(600, 100);
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.hasNext).toBe(false);
  // A filter starts over at the first row, keeping the chosen limit.
  act(() => {
    result.current.setFilters([{ column: "id", op: "gt", values: ["1"] }]);
  });
  expect(result.current.offset).toBe(0);
  expect(result.current.pageSize).toBe(100);
});

test("a limit chosen in the page popover outlives a new page size setting", async () => {
  const { result, rerender } = renderHook(({ size }) => usePagedTable("w1", obj, "t1", size), {
    initialProps: { size: 300 },
  });
  await waitFor(() => expect(result.current.rowCount).not.toBeNull());
  act(() => {
    result.current.goTo(0, 25);
  });
  rerender({ size: 500 });
  await act(async () => {});
  expect(result.current.pageSize).toBe(25);
  expect(ipc.tablePage).toHaveBeenLastCalledWith("w1", expect.objectContaining({ limit: 25 }));
});

test("goTo is refused while changes are pending, and invalid numbers change nothing", async () => {
  const { result } = renderHook(() => usePagedTable("w1", obj, "t1", 300));
  await waitFor(() => expect(result.current.rowCount).not.toBeNull());
  let ok = true;
  act(() => {
    ok = result.current.goTo(-1, 10);
  });
  expect(ok).toBe(false);
  act(() => {
    ok = result.current.goTo(0, 0);
  });
  expect(ok).toBe(false);
  act(() => usePendingChanges.getState().addInsert("t1", obj));
  act(() => {
    ok = result.current.goTo(10, 10);
  });
  expect(ok).toBe(false);
  expect(usePendingChanges.getState().blocked.t1).toBe(true);
  expect(result.current.offset).toBe(0);
  expect(ipc.tablePage).toHaveBeenCalledTimes(1);
});
