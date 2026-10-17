import { modShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import type { Dialect, ObjectRef } from "../../lib/types";
import { Breadcrumb } from "./Breadcrumb";
import { DataGrid, type GridEditing } from "./DataGrid";
import { FilterBar } from "./FilterBar";
import { GridContextMenu, joinMenuGroups } from "./GridContextMenu";
import { PendingChangesPanel } from "./PendingChangesPanel";
import { RowDetailPanel } from "./RowDetailPanel";
import { DEFAULT_PAGE_SIZE, formatRowCount, usePagedTable } from "./usePagedTable";
import { useFkLinks } from "./useFkLinks";
import { useRowDetail } from "./useRowDetail";
import { useSelectionCopy } from "./useSelectionCopy";
import { useTableEditing } from "./useTableEditing";

interface Props {
  workspaceId: string;
  tabId: string;
  object: ObjectRef;
  dialect: Dialect;
}

const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

export function TableDataTab(props: Props) {
  // Kept across foreign key navigation (the panel shows the referenced row once selected).
  const detail = useRowDetail();
  // Another table (foreign key navigation) starts afresh: page, grid, selection, menus.
  return (
    <TableDataView key={JSON.stringify([props.object.schema, props.object.name])} {...props} detail={detail} />
  );
}

function TableDataView({
  workspaceId,
  tabId,
  object,
  dialect,
  detail,
}: Props & { detail: ReturnType<typeof useRowDetail> }) {
  const t = usePagedTable(workspaceId, object, tabId);
  const e = useTableEditing({ workspaceId, tabId, object, result: t.result, reload: t.reload });
  const links = useFkLinks({ workspaceId, tabId, object, dialect, info: e.info, data: t.result, model: e.model });
  const copy = useSelectionCopy(e.model, dialect, object);
  const rows = t.result?.rows.length ?? 0;
  const from = t.page * DEFAULT_PAGE_SIZE + 1;
  const columns = (e.info?.columns ?? t.result?.columns ?? []).map((c) => c.name);
  const editing: GridEditing | undefined = e.editing && {
    ...e.editing,
    linkAt: (row, col) => links.linksAt(row, col).length > 0,
    onOpenLink: (row, col) => {
      const first = links.linksAt(row, col)[0];
      if (first) links.open(first);
    },
  };
  const target = e.menuTarget;
  const menuItems = target
    ? joinMenuGroups([links.menuItems(target.row, target.col), e.menuItems, copy.menuItems(target.block)])
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Breadcrumb workspaceId={workspaceId} tabId={tabId} object={object} filters={t.filters} />
      <FilterBar dialect={dialect} columns={columns} filters={t.filters} onApply={t.setFilters} />
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
      {e.readOnly && (
        <div role="status" className="border-b border-border bg-surface px-3 py-1 text-sm text-muted">
          {e.readOnly}
        </div>
      )}
      {e.editable && (
        <div className="flex items-center gap-3 border-b border-border bg-surface px-3 py-1 text-sm">
          <button
            type="button"
            className={btn}
            onClick={e.addRow}
            disabled={e.committing}
          >
            {strings.grid.addRow}
          </button>
          <button
            type="button"
            className={btn}
            onClick={e.commit}
            disabled={e.count === 0 || e.committing}
          >
            {e.committing ? strings.grid.committing : strings.grid.commit(modShortcut("S"))}
          </button>
          <button
            type="button"
            className={btn}
            onClick={e.discard}
            disabled={e.count === 0 || e.committing}
          >
            {strings.grid.discard}
          </button>
          {e.count > 0 && <span>{strings.grid.pendingCount(e.count)}</span>}
          {e.hint && <span className="ml-auto truncate text-muted">{e.hint}</span>}
        </div>
      )}
      {e.failure && (
        <div role="alert" className="border-b border-border px-3 py-1 text-sm text-danger">
          <p className="break-words">{e.failure}</p>
          <p className="text-muted">{strings.grid.nothingWritten}</p>
        </div>
      )}
      {copy.notice && (
        <div
          role={copy.notice.error ? "alert" : "status"}
          className={`flex items-center gap-2 border-b border-border px-3 py-1 text-sm ${copy.notice.error ? "text-danger" : "text-muted"}`}
        >
          <span className="min-w-0 flex-1 break-words">{copy.notice.text}</span>
          <button
            type="button"
            aria-label={strings.grid.dismiss}
            onClick={copy.dismiss}
            className="shrink-0 rounded-sm px-1.5 text-fg hover:bg-surface-2"
          >
            {strings.grid.dismissText}
          </button>
        </div>
      )}
      {e.blocked && e.count > 0 && (
        <div role="status" className="border-b border-border px-3 py-1 text-sm text-warning">
          {strings.grid.commitOrDiscardFirst}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {t.result && (
              <DataGrid data={t.result} sort={t.sort} onSort={t.setSort} editing={editing} />
            )}
          </div>
          {e.editable && <PendingChangesPanel workspaceId={workspaceId} tabId={tabId} object={object} />}
        </div>
        {detail.open && t.result && e.model && (
          <RowDetailPanel
            workspaceId={workspaceId}
            object={object}
            data={t.result}
            info={e.info}
            model={e.model}
            row={e.selectedRow}
            onChange={e.setValue}
            onAction={e.runAction}
            linksAt={links.linksAt}
            onOpenLink={links.open}
            onClose={detail.close}
          />
        )}
      </div>
      {target && menuItems.length > 0 && (
        <GridContextMenu
          x={target.x}
          y={target.y}
          label={strings.grid.menuLabel}
          items={menuItems}
          onClose={e.closeMenu}
        />
      )}
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
        <button
          type="button"
          className={`${btn} aria-pressed:bg-surface-2`}
          aria-pressed={detail.open}
          title={strings.grid.rowDetailsShortcut(modShortcut("I"))}
          onClick={detail.toggle}
        >
          {strings.grid.rowDetails}
        </button>
        <span data-testid="footer-range">
          {rows === 0
            ? strings.grid.footerEmpty
            : strings.grid.footerRange(from, from + rows - 1, formatRowCount(t.rowCount, t.filters.length > 0))}
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
