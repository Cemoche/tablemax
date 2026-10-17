import { type RefObject, useEffect, useRef, useState } from "react";
import { useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import type { Dialect, ObjectRef } from "../../lib/types";
import { usePendingChanges } from "../../stores/pendingChanges";
import { useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { ConfirmRunDialog } from "../safety/ConfirmRunDialog";
import { StructureTab } from "../structure/StructureTab";
import { type LiveEnvSource, useLiveEnv } from "../workspace/useLiveEnv";
import { Breadcrumb } from "./Breadcrumb";
import { DataGrid, type GridEditing } from "./DataGrid";
import { FilterBar } from "./FilterBar";
import { GridContextMenu, joinMenuGroups } from "./GridContextMenu";
import { PendingChangesPanel } from "./PendingChangesPanel";
import { RowDetailPanel } from "./RowDetailPanel";
import { formatRowCount, usePagedTable } from "./usePagedTable";
import { useFkLinks } from "./useFkLinks";
import { useRowDetail } from "./useRowDetail";
import { useSelectionCopy } from "./useSelectionCopy";
import { useTableEditing } from "./useTableEditing";
import { ViewToggle, useTableView } from "./ViewToggle";

interface Props {
  workspaceId: string;
  tabId: string;
  object: ObjectRef;
  dialect: Dialect;
}

const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

/** Only while the workspace is gone (a table tab always lives in one): the strictest look. */
const NO_WORKSPACE: LiveEnvSource = { connectionId: "", envTag: "prod", safeMode: null };

/**
 * The commit a protected connection refused until confirmed, as QueryTab asks for a batch.
 * Rendered at the tab's root: Mod+S also commits while the structure view is shown.
 */
function CommitConfirmDialog({
  workspaceId,
  tabId,
  onClose,
}: {
  workspaceId: string;
  tabId: string;
  /** Run or Cancel was chosen (the dialog is gone). */
  onClose: () => void;
}) {
  const confirm = usePendingChanges((s) => s.confirming[tabId]);
  const workspace = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId));
  const env = useLiveEnv(workspace ?? NO_WORKSPACE);
  if (!confirm) return null;
  const store = usePendingChanges.getState;
  return (
    <ConfirmRunDialog
      connectionName={workspace?.name ?? ""}
      envTag={env.envTag}
      safeMode={env.mode}
      statements={confirm.statements}
      flagged={confirm.flagged}
      onRun={() => {
        onClose();
        void store().confirmCommit(tabId);
      }}
      onCancel={() => {
        onClose();
        store().cancelConfirm(tabId);
      }}
    />
  );
}

export function TableDataTab(props: Props) {
  // Kept across foreign key navigation (the panel shows the referenced row once selected).
  const { view, setView } = useTableView();
  // Shortcuts of the data view (Mod+I, Alt+←) only act while it is shown.
  const detail = useRowDetail(view === "data");
  // The structure loads when first asked for; then both views stay mounted (hidden) so
  // switching keeps the page, the pending changes and the structure's section.
  const [structureSeen, setStructureSeen] = useState(false);
  if (view === "structure" && !structureSeen) setStructureSeen(true);
  /** The commit confirmation closed: Commit gets the focus back once the tab is unlocked. */
  const refocusCommit = useRef(false);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewToggle view={view} onChange={setView} />
      <div hidden={view !== "data"} className="min-h-0 flex-1">
        {/* Another table (foreign key navigation) starts afresh: page, grid, selection, menus. */}
        <TableDataView
          key={JSON.stringify([props.object.schema, props.object.name])}
          {...props}
          detail={detail}
          active={view === "data"}
          refocusCommit={refocusCommit}
        />
      </div>
      {structureSeen && (
        <div hidden={view !== "structure"} className="min-h-0 flex-1">
          <StructureTab workspaceId={props.workspaceId} object={props.object} dialect={props.dialect} />
        </div>
      )}
      <CommitConfirmDialog
        workspaceId={props.workspaceId}
        tabId={props.tabId}
        onClose={() => {
          refocusCommit.current = true;
        }}
      />
    </div>
  );
}

function TableDataView({
  workspaceId,
  tabId,
  object,
  dialect,
  detail,
  active,
  refocusCommit,
}: Props & { detail: ReturnType<typeof useRowDetail>; active: boolean; refocusCommit: RefObject<boolean> }) {
  const pageSizeSetting = useSettings((s) => s.settings.pageSize);
  const commitShortcut = useEffectiveShortcut("grid.commit");
  const rowDetailsShortcut = useEffectiveShortcut("grid.rowDetails");
  const t = usePagedTable(workspaceId, object, tabId, pageSizeSetting);
  const e = useTableEditing({ workspaceId, tabId, object, result: t.result, reload: t.reload });
  const links = useFkLinks({ workspaceId, tabId, object, dialect, info: e.info, data: t.result, model: e.model });
  const copy = useSelectionCopy(e.model, dialect, object);
  const rows = t.result?.rows.length ?? 0;
  const from = t.page * t.pageSize + 1;
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
  // Once the commit confirmation closed (Cancel, or Run and its commit settled) and the tab
  // is unlocked, the focus comes back to Commit; to + Row when Commit is disabled (nothing
  // left pending after a successful commit).
  const commitRef = useRef<HTMLButtonElement>(null);
  const addRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocusCommit.current || e.confirm || e.locked) return;
    refocusCommit.current = false;
    const commitBtn = commitRef.current;
    (commitBtn && !commitBtn.disabled ? commitBtn : addRowRef.current)?.focus();
  }, [e.confirm, e.locked, refocusCommit]);
  const menuItems = target
    ? joinMenuGroups([links.menuItems(target.row, target.col), e.menuItems, copy.menuItems(target.block)])
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Breadcrumb workspaceId={workspaceId} tabId={tabId} object={object} filters={t.filters} shortcut={active} />
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
            ref={addRowRef}
            type="button"
            className={btn}
            onClick={e.addRow}
            disabled={e.locked}
          >
            {strings.grid.addRow}
          </button>
          <button
            ref={commitRef}
            type="button"
            className={btn}
            onClick={e.commit}
            disabled={e.count === 0 || e.locked || e.outcomeUnknown || e.otherCommitting}
            title={e.otherCommitting ? strings.grid.otherTabCommitting : undefined}
          >
            {e.committing ? strings.grid.committing : strings.grid.commit(formatShortcut(commitShortcut))}
          </button>
          {e.committing ? (
            <button
              type="button"
              className={btn}
              aria-label={strings.grid.cancelCommitLabel}
              onClick={e.cancelCommit}
            >
              {strings.grid.cancelCommit}
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              onClick={e.discard}
              disabled={e.count === 0 || e.locked}
            >
              {strings.grid.discard}
            </button>
          )}
          {e.count > 0 && <span>{strings.grid.pendingCount(e.count)}</span>}
          {e.hint && <span className="ml-auto truncate text-muted">{e.hint}</span>}
        </div>
      )}
      {e.failure && (
        <div role="alert" className="border-b border-border px-3 py-1 text-sm text-danger">
          <p className="break-words">{e.failure}</p>
          {/* Only a rolled-back commit wrote nothing; an unknown outcome says so itself. */}
          {!e.outcomeUnknown && <p className="text-muted">{strings.grid.nothingWritten}</p>}
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
          title={strings.grid.rowDetailsShortcut(formatShortcut(rowDetailsShortcut))}
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
