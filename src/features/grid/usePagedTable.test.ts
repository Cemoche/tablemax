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
  usePendingChanges.setState({ tabs: {}, blocked: {}, committing: {}, applied: {}, editorOpen: {} });
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
  });
  expect(ipc.tableCount).toHaveBeenCalledWith("w1", obj, []);
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
  act(() => usePendingChanges.getState().addInsert("t1"));
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
