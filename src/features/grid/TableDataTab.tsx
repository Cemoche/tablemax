import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { useAction } from "../../lib/keymap";
import { strings } from "../../lib/strings";
import type { Dialect, Filter, FilterCombine, ObjectRef, SortDir } from "../../lib/types";
import { useChrome, useOnRequest } from "../../stores/chrome";
import { useGridViews } from "../../stores/gridViews";
import { usePendingChanges } from "../../stores/pendingChanges";
import { useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { ConfirmRunDialog } from "../safety/ConfirmRunDialog";
import { IndexView } from "../structure/IndexView";
import { StructureTab } from "../structure/StructureTab";
import { type LiveEnvSource, useLiveEnv } from "../workspace/useLiveEnv";
import { Breadcrumb } from "./Breadcrumb";
import { cellContent } from "./cellContent";
import { reconcileLayout } from "./columnLayout";
import { DataGrid, type GridEditing } from "./DataGrid";
import { isTruncated } from "./editing";
import { FilterBar } from "./FilterBar";
import { GridContextMenu, type MenuItem, joinMenuGroups } from "./GridContextMenu";
import { PendingChangesPanel } from "./PendingChangesPanel";
import { QuickLook } from "./QuickLook";
import { RowDetailPanel } from "./RowDetailPanel";
import { type TableView, TableBottomBar, useTableView } from "./TableBottomBar";
import { formatRowCount, usePagedTable } from "./usePagedTable";
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
  /** Run or Cancel was chosen (the dialog is gone); `opener` had the focus when it opened. */
  onClose: (opener: Element | null) => void;
}) {
  const confirm = usePendingChanges((s) => s.confirming[tabId]);
  const workspace = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId));
  const env = useLiveEnv(workspace ?? NO_WORKSPACE);
  // What had the focus when the confirmation appeared (the toolbar's Commit, the grid…),
  // read before the dialog's own autofocus moves it (as useRestoreFocus does).
  const opener = useRef<Element | null>(null);
  if (!confirm) {
    opener.current = null;
    return null;
  }
  opener.current ??= document.activeElement;
  const store = usePendingChanges.getState;
  return (
    <ConfirmRunDialog
      connectionName={workspace?.name ?? ""}
      envTag={env.envTag}
      safeMode={env.mode}
      statements={confirm.statements}
      flagged={confirm.flagged}
      onRun={() => {
        onClose(opener.current);
        void store().confirmCommit(tabId);
      }}
      onCancel={() => {
        onClose(opener.current);
        store().cancelConfirm(tabId);
      }}
    />
  );
}

export function TableDataTab(props: Props) {
  // Kept across foreign key navigation (the panel shows the referenced row once selected).
  const { view, setView } = useTableView(props.tabId);
  // Shortcuts of the data view (Ctrl+Space, Alt+←) only act while it is shown.
  const detail = useRowDetail(view === "data");
  // The structure and the indexes load when first asked for; then every view seen stays
  // mounted (hidden) so switching keeps the page, the pending changes and the structure's section.
  const [seen, setSeen] = useState({ structure: false, index: false });
  if (view !== "data" && !seen[view]) setSeen((s) => ({ ...s, [view]: true }));
  /**
   * The commit confirmation closed: once the tab is unlocked the focus goes back to what
   * opened it (the toolbar's Commit, the grid), else to + Row or the selected view tab.
   */
  const refocusCommit = useRef<{ opener: Element | null } | null>(null);
  const toggleRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const allIds: Record<TableView, string> = { data: `${id}-data`, structure: `${id}-structure`, index: `${id}-index` };
  const panelIds: Partial<Record<TableView, string>> = {
    data: allIds.data,
    ...(seen.structure ? { structure: allIds.structure } : {}),
    ...(seen.index ? { index: allIds.index } : {}),
  };
  const otherViews = (
    <>
      {seen.structure && (
        <div
          id={allIds.structure}
          role="tabpanel"
          aria-label={strings.grid.view.structure}
          hidden={view !== "structure"}
          className="min-h-0 flex-1"
        >
          <StructureTab workspaceId={props.workspaceId} object={props.object} dialect={props.dialect} />
        </div>
      )}
      {seen.index && (
        <div
          id={allIds.index}
          role="tabpanel"
          aria-label={strings.grid.view.index}
          hidden={view !== "index"}
          className="min-h-0 flex-1"
        >
          <IndexView workspaceId={props.workspaceId} object={props.object} />
        </div>
      )}
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Another table (foreign key navigation) starts afresh: page, grid, selection, menus. */}
      <TableDataView
        key={JSON.stringify([props.object.schema, props.object.name])}
        {...props}
        detail={detail}
        view={view}
        onView={setView}
        panelIds={panelIds}
        otherViews={otherViews}
        refocusCommit={refocusCommit}
        toggleRef={toggleRef}
      />
      <CommitConfirmDialog
        workspaceId={props.workspaceId}
        tabId={props.tabId}
        onClose={(opener) => {
          refocusCommit.current = { opener };
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
  view,
  onView,
  panelIds,
  otherViews,
  refocusCommit,
  toggleRef,
}: Props & {
  detail: ReturnType<typeof useRowDetail>;
  view: TableView;
  onView: (v: TableView) => void;
  panelIds: Partial<Record<TableView, string>>;
  /** The structure and index views (each mounted once seen), shown above the bottom bar in place of the rows. */
  otherViews: ReactNode;
  refocusCommit: RefObject<{ opener: Element | null } | null>;
  toggleRef: RefObject<HTMLDivElement | null>;
}) {
  const active = view === "data";
  const pageSizeSetting = useSettings((s) => s.settings.pageSize);
  const t = usePagedTable(workspaceId, object, tabId, pageSizeSetting);
  // The toolbar's Reload (and Mod+R) reload this tab's page like its own Reload button.
  useOnRequest(useChrome((s) => s.reloads[tabId] ?? 0), t.reload);
  const e = useTableEditing({ workspaceId, tabId, object, result: t.result, reload: t.reload });
  const links = useFkLinks({ workspaceId, tabId, object, dialect, info: e.info, data: t.result, model: e.model });
  const copy = useSelectionCopy(e.model, dialect, object);
  const rows = t.result?.rows.length ?? 0;
  const from = t.offset + 1;
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
  // Column layout of this table, kept for the session (see DataGrid); the menu's whole-row
  // copies follow the columns as shown.
  const connectionId = useWorkspaces((st) => st.workspaces.find((w) => w.id === workspaceId)?.connectionId);
  const database = useWorkspaces((st) => st.workspaces.find((w) => w.id === workspaceId)?.database ?? null);
  const layoutKey = JSON.stringify([connectionId ?? workspaceId, database, object.schema, object.name]);
  const storedLayout = useGridViews((st) => st.layouts[layoutKey]);
  const [quickLook, setQuickLook] = useState<{ row: number; col: number } | null>(null);
  /** Bumped to put the focus back in the grid (Escape in the row details). */
  const [gridFocus, setGridFocus] = useState(0);
  /** Rows selected in the grid: the bottom bar's centre says "1 of 415 rows selected". */
  const [selectedRows, setSelectedRows] = useState(0);
  const [filterStart, setFilterStart] = useState<{ column: string; seq: number } | null>(null);
  const modelCols = e.model?.columns ?? [];
  const shownCols = (() => {
    const l = reconcileLayout(storedLayout, modelCols);
    return l.order.filter((n) => !l.hidden.includes(n)).map((n) => modelCols.indexOf(n));
  })();
  /**
   * Narrows the rows with one more filter, ANDed (the same one twice is kept once). Under
   * OR one more filter would widen them instead: the filter then replaces the others.
   */
  const addFilter = (f: Filter) => {
    if (t.combine === "or" && t.filters.length > 1) {
      t.setFilters([f]);
      return;
    }
    const key = JSON.stringify(f);
    t.setFilters([...t.filters.filter((x) => JSON.stringify(x) !== key), f]);
  };

  // The filter bar (Filters, Ctrl+F). It opens by itself when filters get applied from
  // elsewhere (a quick filter, a foreign key, Filter with column) so they always show.
  const filterBarId = useId();
  const filtersButtonRef = useRef<HTMLButtonElement>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => t.filters.length > 0);
  const [barMounted, setBarMounted] = useState(filtersOpen);
  if (filtersOpen && !barMounted) setBarMounted(true);
  /** Each new value puts the focus in the bar (opened from the keyboard or its button). */
  const [filterFocus, setFilterFocus] = useState(0);
  /** What had the focus when the bar was opened from the keyboard: it gets it back on close. */
  const filterOpener = useRef<Element | null>(null);
  const appliedKey = JSON.stringify([t.filters, t.combine]);
  const [seenApplied, setSeenApplied] = useState(appliedKey);
  if (seenApplied !== appliedKey) {
    setSeenApplied(appliedKey);
    if (t.filters.length > 0 && !filtersOpen) setFiltersOpen(true);
  }
  const openFilters = () => {
    filterOpener.current = document.activeElement;
    setFiltersOpen(true);
    setFilterFocus((n) => n + 1);
  };
  const closeFilters = () => {
    const bar = filterBarRef.current;
    if (bar?.contains(document.activeElement)) {
      const back = filterOpener.current;
      const target =
        back instanceof HTMLElement && back.isConnected && !bar.contains(back) && back !== document.body
          ? back
          : filtersButtonRef.current;
      target?.focus();
    }
    filterOpener.current = null;
    setFiltersOpen(false);
    setFilterFocus(0);
    setFilterStart(null);
  };
  // Ctrl+F: opens the bar with the focus in it; from outside an open bar, moves the focus
  // into it (inside the bar the bar closes itself). Not in a text field: it is the field's.
  useAction(
    "grid.filters",
    () => {
      if (!filtersOpen) openFilters();
      else {
        filterOpener.current = document.activeElement;
        setFilterFocus((n) => n + 1);
      }
    },
    { enabled: active, skipInEditable: true },
  );
  const [columnsOpen, setColumnsOpen] = useState(false);
  // Capture + stop, like the view keys: the grid would take Alt+F's letter as the start of a
  // cell edit.
  useAction("grid.columns", () => setColumnsOpen((o) => !o), {
    enabled: active,
    skipInEditable: true,
    capture: true,
    stopPropagation: true,
  });
  const quickFilterItems = (row: number, col: number): MenuItem[] => {
    const name = e.model?.columns[col];
    const cell = e.model?.cell(row, col);
    if (name === undefined || !cell) return [];
    const items: MenuItem[] = [
      { heading: strings.grid.menu.quickFilter },
      {
        label: strings.grid.menu.filterIsNullText,
        ariaLabel: strings.grid.menu.filterIsNull(name),
        indent: true,
        onSelect: () => addFilter({ column: name, op: "isNull", values: [] }),
      },
    ];
    const v = cell.value;
    // PostgreSQL `json` has no = operator (jsonb has): the filter would fail.
    const baseType = e.info?.columns.find((c) => c.name === name)?.baseType.trim().toLowerCase();
    const noEquals = dialect === "postgres" && baseType === "json";
    // "= value" for a whole, loaded value (not NULL, DEFAULT, binary or a truncated preview).
    if (v !== "default" && v.t !== "null" && v.t !== "bytes" && !isTruncated(v) && !cell.edited && !noEquals) {
      const text = cellContent(v).copyText;
      const shown = text.length > 40 ? text.slice(0, 40) + strings.grid.menuValueEllipsis : text;
      items.push({
        label: strings.grid.menu.filterEqualsText(shown),
        ariaLabel: strings.grid.menu.filterEquals(name, shown),
        indent: true,
        onSelect: () => addFilter({ column: name, op: "eq", values: [text] }),
      });
    }
    return items;
  };
  const quickLookItems = (row: number, col: number): MenuItem[] => [
    { label: strings.grid.menu.quickLook, shortcut: "Enter", onSelect: () => setQuickLook({ row, col }) },
  ];
  /** The record and column of the open Quick Look, read now (it may have moved or gone). */
  const quickCell = quickLook && e.model ? e.model.cell(quickLook.row, quickLook.col) : null;
  const quickKey = quickLook ? e.model?.rowKeyAt(quickLook.row) : null;
  // Once the commit confirmation closed (Cancel, or Run and its commit settled) and the tab
  // is unlocked, the focus goes back to what opened it when it can still take it (the
  // toolbar's Commit is disabled after a successful commit); else to + Row, or the selected
  // view tab while another view is shown.
  const addRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = refocusCommit.current;
    if (!back || e.confirm || e.locked) return;
    refocusCommit.current = null;
    const opener = back.opener;
    if (
      opener instanceof HTMLElement &&
      opener !== document.body &&
      opener.isConnected &&
      !opener.closest("[hidden]") &&
      !(opener as HTMLButtonElement).disabled
    ) {
      opener.focus();
      return;
    }
    const tab = toggleRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) tab?.focus();
    else (addRowRef.current ?? tab)?.focus();
  }, [active, e.confirm, e.locked, refocusCommit, toggleRef]);
  // + Row (Ctrl+I) as its button; not in a field (the filter bar takes Ctrl+I itself).
  useAction(
    "grid.addRow",
    () => {
      if (!e.locked) e.addRow();
    },
    { enabled: active && e.editable, skipInEditable: true },
  );
  const menuItems = target
    ? joinMenuGroups(
        target.col === null
          ? [links.menuItems(target.row, target.col), copy.menuItems(target.block, shownCols), e.rowItems]
          : [
              [...e.reasonItems, ...quickLookItems(target.row, target.col)],
              links.menuItems(target.row, target.col),
              e.setValueItems,
              copy.menuItems(target.block, shownCols),
              quickFilterItems(target.row, target.col),
              e.rowItems,
            ],
      )
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        id={panelIds.data}
        role="tabpanel"
        aria-label={strings.grid.view.data}
        hidden={!active}
        className="min-h-0 flex-1"
      >
        <div className="flex h-full min-h-0 flex-col">
          <Breadcrumb workspaceId={workspaceId} tabId={tabId} object={object} filters={t.filters} combine={t.combine} />
          {/* Kept once opened, hidden while closed: rows typed but not applied come back (#103). */}
          {(filtersOpen || barMounted) && (
            <div ref={filterBarRef} hidden={!filtersOpen}>
              <FilterBar
                id={filterBarId}
                dialect={dialect}
                columns={columns}
                filters={t.filters}
                combine={t.combine}
                onApply={(filters: Filter[], combine: FilterCombine) => t.setFilters(filters, combine)}
                onClose={closeFilters}
                open={filtersOpen}
                previewSql={(filters: Filter[], combine: FilterCombine) =>
                  ipc.filtersPreviewSql(workspaceId, object, filters, combine)
                }
                focusSeq={filterFocus}
                start={filterStart}
              />
            </div>
          )}
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
          {/* Commit / Discard / Cancel and the pending count are the toolbar's (#103). */}
          {e.hint && (
            <div role="status" className="truncate border-b border-border bg-surface px-3 py-1 text-sm text-muted">
              {e.hint}
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
                  <DataGrid
                    data={t.result}
                    sort={t.sort}
                    onSort={t.setSort}
                    editing={editing}
                    layoutKey={layoutKey}
                    onSortTo={(column: string, dir: SortDir | null) => t.setSortTo(column, dir)}
                    onFilterColumn={(column) => {
                      setFiltersOpen(true);
                      setFilterStart((f) => ({ column, seq: (f?.seq ?? 0) + 1 }));
                    }}
                    onPageKey={(dir) => {
                      if (t.loading) return;
                      if (dir === "previous") t.prevPage();
                      else t.nextPage();
                    }}
                    onToggleDetails={detail.toggle}
                    onQuickLook={(row, col) => setQuickLook({ row, col })}
                    onRowsAction={e.rowsAction}
                    onCopyCells={copy.copyCells}
                    onSelectedRows={setSelectedRows}
                    focusRequest={gridFocus}
                  />
                )}
              </div>
              {e.editable && <PendingChangesPanel workspaceId={workspaceId} tabId={tabId} object={object} />}
            </div>
            {/* Shown as soon as the switch is on: empty while the page loads or failed to. */}
            {detail.open && (
              <RowDetailPanel
                workspaceId={workspaceId}
                object={object}
                data={t.result ?? null}
                info={e.info}
                model={e.model ?? null}
                row={e.selectedRow}
                onChange={e.setValue}
                onAction={e.runAction}
                linksAt={links.linksAt}
                onOpenLink={links.open}
                onClose={detail.close}
                onEscape={() => setGridFocus((n) => n + 1)}
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
          {quickLook && quickCell && (
            <QuickLook
              column={e.model?.columns[quickLook.col] ?? ""}
              value={quickCell.value}
              load={
                quickCell.truncated && quickKey
                  ? () => ipc.cellValue(workspaceId, object, quickKey, e.model!.columns[quickLook.col])
                  : undefined
              }
              onClose={() => setQuickLook(null)}
            />
          )}
        </div>
      </div>
      {otherViews}
      <TableBottomBar
        view={view}
        onView={onView}
        tabsRef={toggleRef}
        panelIds={panelIds}
        data={
          active
            ? {
                addRow: e.editable ? { onClick: e.addRow, disabled: e.locked, ref: addRowRef } : undefined,
                counter: e.committing
                  ? strings.grid.committing
                  : rows === 0
                    ? t.loading && !t.result
                      ? strings.grid.loading
                      : strings.grid.footerEmpty
                    : selectedRows > 0
                      ? strings.grid.rowsSelected(selectedRows, e.model?.rows.length ?? rows)
                      : t.offset === 0 && !t.hasNext && t.rowCount?.t === "exact"
                        ? strings.grid.rowCount(rows)
                        : strings.grid.footerRange(from, from + rows - 1, formatRowCount(t.rowCount, t.filters.length > 0)),
                busy: t.loading || e.committing,
                filters: {
                  open: filtersOpen,
                  count: t.filters.length,
                  controls: filterBarId,
                  onToggle: () => (filtersOpen ? closeFilters() : openFilters()),
                  ref: filtersButtonRef,
                },
                columns: { names: modelCols, layoutKey, open: columnsOpen, onOpenChange: setColumnsOpen },
                paging: {
                  hasPrev: t.hasPrev,
                  hasNext: t.hasNext,
                  disabled: t.loading,
                  onPrev: t.prevPage,
                  onNext: t.nextPage,
                  offset: t.offset,
                  limit: t.pageSize,
                  onGo: t.goTo,
                },
              }
            : null
        }
      />
    </div>
  );
}
