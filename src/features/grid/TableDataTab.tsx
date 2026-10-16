import { strings } from "../../lib/strings";
import type { ObjectRef } from "../../lib/types";
import { DataGrid } from "./DataGrid";
import { DEFAULT_PAGE_SIZE, formatRowCount, usePagedTable } from "./usePagedTable";

interface Props {
  workspaceId: string;
  tabId: string;
  object: ObjectRef;
}

const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

export function TableDataTab({ workspaceId, tabId, object }: Props) {
  const t = usePagedTable(workspaceId, object, tabId);
  const rows = t.result?.rows.length ?? 0;
  const from = t.page * DEFAULT_PAGE_SIZE + 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {t.error && (
        <div role="alert" className="flex items-center gap-3 border-b border-border p-3 text-danger">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{strings.grid.loadFailed}</p>
            <p className="break-words">{t.error.message}</p>
            {t.error.kind === "connectionLost" && (
              <p className="text-muted">{strings.grid.reopenHint}</p>
            )}
          </div>
          <button type="button" className={btn} onClick={t.reload}>
            {strings.grid.retry}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {t.result && <DataGrid data={t.result} sort={t.sort} onSort={t.setSort} />}
      </div>
      <div className="flex items-center gap-3 border-t border-border bg-surface px-3 py-1 text-sm">
        <button type="button" className={btn} onClick={t.prevPage} disabled={!t.hasPrev || t.loading}>
          {strings.grid.prev}
        </button>
        <button type="button" className={btn} onClick={t.nextPage} disabled={!t.hasNext || t.loading}>
          {strings.grid.next}
        </button>
        <button type="button" className={btn} onClick={t.reload} disabled={t.loading}>
          {strings.grid.reload}
        </button>
        <span data-testid="footer-range">
          {rows === 0
            ? strings.grid.footerEmpty
            : strings.grid.footerRange(from, from + rows - 1, formatRowCount(t.rowCount))}
        </span>
        <span className="ml-auto text-muted">
          {t.loading
            ? strings.grid.loading
            : t.elapsedMs !== null
              ? strings.grid.loadedIn(t.elapsedMs)
              : ""}
        </span>
      </div>
    </div>
  );
}
