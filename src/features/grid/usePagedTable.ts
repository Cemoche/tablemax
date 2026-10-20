import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { AppError, Filter, FilterCombine, ObjectRef, ResultSet, RowCount, SortDir } from "../../lib/types";
import { useGridViews } from "../../stores/gridViews";
import { guardPending, usePendingChanges } from "../../stores/pendingChanges";
import { SETTINGS_BOUNDS } from "../settings/bounds";

export const DEFAULT_PAGE_SIZE = 300;
/** Bounds of the page popover's limit (the page size setting's maximum: a page stays light). */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = SETTINGS_BOUNDS.pageSize.max;

const nf = new Intl.NumberFormat("en-US");

/** With filters an estimate is the capped count (at least that many rows): "<threshold>+" (the exact count threshold setting). */
export function formatRowCount(c: RowCount | null, filtered = false): string {
  if (!c) return strings.grid.countUnknown;
  if (c.t === "exact") return nf.format(c.v);
  return filtered ? strings.grid.countAtLeast(c.v) : strings.grid.estimatePrefix + nf.format(c.v);
}

export function usePagedTable(
  workspaceId: string,
  object: ObjectRef,
  tabId: string,
  wantedPageSize = DEFAULT_PAGE_SIZE,
) {
  // The tab latches its page size in its view (it survives tab switches, like the pending
  // changes): a new setting is adopted only while nothing is pending (paging is refused then,
  // and the offsets stay consistent), and always restarts at page 0. A limit chosen in the
  // page popover replaces the setting for the tab.
  const view = useGridViews((s) => s.views[tabId]) ?? useGridViews.getState().getView(tabId);
  const pageSize = view.limit ?? view.pageSize ?? wantedPageSize;
  const pendingCount = usePendingChanges((s) => s.count(tabId));
  const ownLimit = view.limit !== undefined;
  useEffect(() => {
    if (ownLimit) return;
    const set = useGridViews.getState().setView;
    if (view.pageSize === undefined) set(tabId, { pageSize: wantedPageSize });
    else if (view.pageSize !== wantedPageSize && pendingCount === 0) {
      set(tabId, { pageSize: wantedPageSize, page: 0, startOffset: undefined });
    }
  }, [wantedPageSize, view.pageSize, pendingCount, tabId, ownLimit]);
  const { page, sort, filters } = view;
  const combine: FilterCombine = view.combine ?? "and";
  const startOffset = view.startOffset ?? 0;
  const offset = startOffset + page * pageSize;
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
  // Effects depend on the filters' content (and how they are joined), not on the array's identity.
  const filterKey = JSON.stringify([filters, combine]);

  useEffect(() => {
    const mine = ++seq.current;
    const started = performance.now();
    // A page requested after a commit ended unlocks the tab once it settles.
    const pending = usePendingChanges.getState();
    const epoch = pending.epochOf(tabId);
    setLoading(true);
    ipc
      .tablePage(workspaceId, {
        object,
        limit: pageSize,
        offset,
        sort: sortCol && sortDir ? [sortCol, sortDir] : null,
        filters,
        combine,
      })
      .then((r) => {
        if (mine !== seq.current) return;
        pending.pageSettled(tabId, epoch, true);
        setResult(r);
        setError(null);
        setElapsedMs(Math.round(performance.now() - started));
        setLoading(false);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        pending.pageSettled(tabId, epoch, false);
        setError(toAppError(e));
        setLoading(false);
      });
    return () => {
      seq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, object.schema, object.name, offset, sortCol, sortDir, filterKey, pageSize, tick, tabId]);

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
      .tableCount(workspaceId, object, filters, combine)
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
  const pageCount = rowCount ? Math.max(1, Math.ceil((rowCount.v - startOffset) / pageSize)) : page + 1;
  // An estimate (or a capped filtered count) may be off either way: only a full page
  // offers the next one.
  const hasNext = !rowCount || rowCount.t === "estimate" ? fullPage : offset + pageSize < rowCount.v;

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
      setView(tabId, { sort: next, page: 0, startOffset: undefined });
    },
    [tabId, setView],
  );
  /** The header menu's sort: `col` one way, or no sort (null). */
  const setSortTo = useCallback(
    (col: string, dir: SortDir | null) => {
      if (!guardPending(tabId)) return;
      setView(tabId, { sort: dir === null ? null : [col, dir], page: 0, startOffset: undefined });
    },
    [tabId, setView],
  );
  /** `next` joined by `how` (AND by default), from the first row. False (nothing changes) while changes are pending. */
  const setFilters = useCallback(
    (next: Filter[], how: FilterCombine = "and") => {
      if (!guardPending(tabId)) return false;
      setView(tabId, { filters: next, combine: how === "or" ? "or" : undefined, page: 0, startOffset: undefined });
      return true;
    },
    [tabId, setView],
  );
  const nextPage = useCallback(() => {
    const v = useGridViews.getState().getView(tabId);
    if (hasNext && guardPending(tabId)) setView(tabId, { page: v.page + 1 });
  }, [tabId, hasNext, setView]);
  // Back from page 0 of a popover offset: one page earlier, the first row at most.
  const prevPage = useCallback(() => {
    const v = useGridViews.getState().getView(tabId);
    const start = v.startOffset ?? 0;
    if (v.page === 0 && start === 0) return;
    if (!guardPending(tabId)) return;
    if (v.page > 0) setView(tabId, { page: v.page - 1 });
    else setView(tabId, { startOffset: Math.max(0, start - pageSize) || undefined });
  }, [tabId, setView, pageSize]);
  /**
   * The page popover's Go: `limit` rows from row `offset` (0-based). False when a number is
   * out of bounds (not a whole number, offset < 0, limit outside LIMIT_MIN…LIMIT_MAX) or
   * changes are pending.
   */
  const goTo = useCallback(
    (at: number, limit: number) => {
      if (!Number.isSafeInteger(at) || at < 0) return false;
      if (!Number.isSafeInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) return false;
      if (!guardPending(tabId)) return false;
      setView(tabId, { limit, startOffset: at === 0 ? undefined : at, page: 0 });
      return true;
    },
    [tabId, setView],
  );
  // Refused like paging while changes are pending (after a commit nothing is pending),
  // except after a commit whose outcome is unknown: the user must reload to check.
  const reload = useCallback(() => {
    if (usePendingChanges.getState().guardReload(tabId)) setTick((t) => t + 1);
  }, [tabId]);

  return {
    result,
    page,
    pageCount,
    hasNext,
    hasPrev: offset > 0,
    pageSize,
    offset,
    goTo,
    rowCount,
    sort,
    setSort,
    setSortTo,
    filters,
    combine,
    setFilters,
    nextPage,
    prevPage,
    reload,
    loading,
    error,
    elapsedMs,
  };
}
