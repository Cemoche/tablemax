import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { AppError, Filter, ObjectRef, ResultSet, RowCount } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { guardPending } from "../../stores/pendingChanges";

export const DEFAULT_PAGE_SIZE = 300;

const nf = new Intl.NumberFormat("en-US");

/** With filters an estimate is the capped count (at least that many rows): "500,000+". */
export function formatRowCount(c: RowCount | null, filtered = false): string {
  if (!c) return strings.grid.countUnknown;
  if (c.t === "exact") return nf.format(c.v);
  return filtered ? strings.grid.countAtLeast(c.v) : strings.grid.estimatePrefix + nf.format(c.v);
}

export function usePagedTable(
  workspaceId: string,
  object: ObjectRef,
  tabId: string,
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const view = useGridViews((s) => s.views[tabId]) ?? useGridViews.getState().getView(tabId);
  const { page, sort, filters } = view;
  const [result, setResult] = useState<ResultSet | null>(null);
  const [rowCount, setRowCount] = useState<RowCount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const countSeq = useRef(0);

  const sortCol = sort?.[0] ?? null;
  const sortDir = sort?.[1] ?? null;
  // Effects depend on the filters' content, not on the array's identity.
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    const mine = ++seq.current;
    const started = performance.now();
    setLoading(true);
    ipc
      .tablePage(workspaceId, {
        object,
        limit: pageSize,
        offset: page * pageSize,
        sort: sortCol && sortDir ? [sortCol, sortDir] : null,
        filters,
      })
      .then((r) => {
        if (mine !== seq.current) return;
        setResult(r);
        setError(null);
        setElapsedMs(Math.round(performance.now() - started));
        setLoading(false);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setError(toAppError(e));
        setLoading(false);
      });
    return () => {
      seq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, object.schema, object.name, page, sortCol, sortDir, filterKey, pageSize, tick]);

  // Count is independent of paging/sorting: once per mount, on reload and per filters.
  const countedFilters = useRef(filterKey);
  useEffect(() => {
    const mine = ++countSeq.current;
    // A reload keeps the count on screen until the new one arrives; other filters do not.
    if (countedFilters.current !== filterKey) {
      countedFilters.current = filterKey;
      setRowCount(null);
    }
    ipc
      .tableCount(workspaceId, object, filters)
      .then((c) => {
        if (mine === countSeq.current) setRowCount(c);
      })
      .catch(() => {
        if (mine === countSeq.current) setRowCount(null);
      });
    return () => {
      countSeq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, object.schema, object.name, filterKey, tick]);

  const fullPage = (result?.rows.length ?? 0) === pageSize;
  const pageCount = rowCount ? Math.max(1, Math.ceil(rowCount.v / pageSize)) : page + 1;
  // An estimate (or a capped filtered count) may be short: a full page offers the next one.
  const hasNext = !rowCount
    ? fullPage
    : page + 1 < pageCount || (rowCount.t === "estimate" && fullPage);

  // Page, sort and filter changes are refused while changes are pending (they would apply to
  // rows the user no longer sees); guardPending flags the tab with the reason.
  const setView = useGridViews.getState().setView;
  const setSort = useCallback(
    (col: string) => {
      if (!guardPending(tabId)) return;
      const cur = useGridViews.getState().getView(tabId).sort;
      let next: typeof cur;
      if (!cur || cur[0] !== col) next = [col, "asc"];
      else if (cur[1] === "asc") next = [col, "desc"];
      else next = null;
      setView(tabId, { sort: next, page: 0 });
    },
    [tabId, setView],
  );
  /** False (nothing changes) while changes are pending. */
  const setFilters = useCallback(
    (next: Filter[]) => {
      if (!guardPending(tabId)) return false;
      setView(tabId, { filters: next, page: 0 });
      return true;
    },
    [tabId, setView],
  );
  const nextPage = useCallback(() => {
    const v = useGridViews.getState().getView(tabId);
    if (hasNext && guardPending(tabId)) setView(tabId, { page: v.page + 1 });
  }, [tabId, hasNext, setView]);
  const prevPage = useCallback(() => {
    const v = useGridViews.getState().getView(tabId);
    if (v.page > 0 && guardPending(tabId)) setView(tabId, { page: v.page - 1 });
  }, [tabId, setView]);
  // Refused like paging while changes are pending (after a commit nothing is pending).
  const reload = useCallback(() => {
    if (guardPending(tabId)) setTick((t) => t + 1);
  }, [tabId]);

  return {
    result,
    page,
    pageCount,
    hasNext,
    hasPrev: page > 0,
    rowCount,
    sort,
    setSort,
    filters,
    setFilters,
    nextPage,
    prevPage,
    reload,
    loading,
    error,
    elapsedMs,
  };
}
