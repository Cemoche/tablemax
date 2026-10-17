import { useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { modShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import type { EditValue, ObjectRef } from "../../lib/types";
import { usePendingChanges } from "../../stores/pendingChanges";
import { DataGrid, type GridEditing } from "./DataGrid";
import { buildGridModel, type MenuAction, menuActions } from "./editModel";
import { cellText, insertValuesOf, parseEditorInput, readOnlyReason } from "./editing";
import { GridContextMenu, type MenuItem } from "./GridContextMenu";
import { DEFAULT_PAGE_SIZE, formatRowCount, usePagedTable } from "./usePagedTable";
import { useTableInfo } from "./useTableInfo";

interface Props {
  workspaceId: string;
  tabId: string;
  object: ObjectRef;
}

const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

export function TableDataTab({ workspaceId, tabId, object }: Props) {
  const t = usePagedTable(workspaceId, object, tabId);
  const { info, error: infoError } = useTableInfo(workspaceId, object);
  const pending = usePendingChanges((s) => s.tabs[tabId]);
  const count = usePendingChanges((s) => s.count(tabId));
  const blocked = usePendingChanges((s) => s.blocked[tabId] ?? false);
  const committing = usePendingChanges((s) => s.committing[tabId] ?? false);
  const appliedSeq = usePendingChanges((s) => s.applied[tabId] ?? 0);
  const [menu, setMenu] = useState<{ row: number; col: number | null; x: number; y: number } | null>(
    null,
  );
  /** Why the cell the user tried to edit is read-only, or a failed load. */
  const [hint, setHint] = useState<string | null>(null);

  const rows = t.result?.rows.length ?? 0;
  const from = t.page * DEFAULT_PAGE_SIZE + 1;
  const editable = info !== null && readOnlyReason(info) === null;
  const readOnly = infoError
    ? strings.grid.infoFailed(infoError.message)
    : info
      ? readOnlyReason(info)
      : null;

  // A successful commit (from here or Mod+S) reloads the page and the count.
  const seenApplied = useRef(appliedSeq);
  const { reload } = t;
  useEffect(() => {
    if (appliedSeq === seenApplied.current) return;
    seenApplied.current = appliedSeq;
    reload();
  }, [appliedSeq, reload]);

  const model = useMemo(
    () => (t.result ? buildGridModel(t.result, info, pending, committing) : null),
    [t.result, info, pending, committing],
  );

  const store = usePendingChanges.getState;
  const commit = () => void store().commit(tabId, workspaceId, object);

  const setValue = (row: number, col: number, value: EditValue) => {
    const r = model?.rows[row];
    const name = model?.columns[col];
    if (!model || !r || name === undefined || !t.result) return;
    if (r.kind === "insert") store().setInsertCell(tabId, r.tempId, name, value);
    else if (r.key) store().setCell(tabId, r.key, name, value, t.result.rows[r.index], model.columns);
  };

  const loadFull = async (row: number, col: number) => {
    const key = model?.rowKeyAt(row);
    const name = model?.columns[col];
    if (!key || name === undefined) throw { kind: "invalid", message: strings.grid.nullKey };
    return cellText(await ipc.cellValue(workspaceId, object, key, name));
  };

  const duplicate = async (row: number) => {
    const r = model?.rows[row];
    if (!model || !r || !info || !t.result) return;
    if (r.kind === "insert") {
      store().addInsert(tabId, r.values);
      return;
    }
    const { values, truncated } = insertValuesOf(info, model.columns, t.result.rows[r.index]);
    try {
      for (const name of truncated) {
        if (!r.key) break;
        const v = await ipc.cellValue(workspaceId, object, r.key, name);
        values[name] = { t: "text", v: cellText(v) };
      }
    } catch (e) {
      setHint(strings.grid.editorLoadFailed(toAppError(e).message));
      return;
    }
    store().addInsert(tabId, values);
  };

  const runAction = (a: MenuAction, row: number, col: number | null) => {
    const r = model?.rows[row];
    if (!model || !r) return;
    const name = col === null ? undefined : model.columns[col];
    switch (a) {
      case "setNull":
        if (col !== null) setValue(row, col, parseEditorInput("", { setNull: true }));
        break;
      case "setEmpty":
        if (col !== null) setValue(row, col, parseEditorInput("", {}));
        break;
      case "setDefault":
      case "revertCell":
        if (name === undefined) break;
        if (r.kind === "insert") store().setInsertCell(tabId, r.tempId, name, { t: "default" });
        else if (r.key) store().revertCell(tabId, r.key, name);
        break;
      case "duplicateRow":
        void duplicate(row);
        break;
      case "deleteRow":
      case "restoreRow":
        if (r.kind === "insert") store().removeInsert(tabId, r.tempId);
        else if (r.key) store().toggleDelete(tabId, r.key);
        break;
    }
  };

  const editing: GridEditing | undefined = model
    ? {
        model,
        onEdit: (row, col, text) => setValue(row, col, parseEditorInput(text, {})),
        loadFull,
        onContextMenu: (row, col, x, y) => setMenu({ row, col, x, y }),
        onActivate: (row, col) => setHint(model.cell(row, col).reason),
      }
    : undefined;

  const menuItems: MenuItem[] = [];
  if (menu && model) {
    const reason = menu.col !== null ? model.cell(menu.row, menu.col).reason : null;
    if (reason) menuItems.push({ label: reason, disabled: true, onSelect: () => {} }, "separator");
    for (const a of menuActions(model, menu.row, menu.col)) {
      if (a === "duplicateRow" && menuItems.length > 0 && menuItems[menuItems.length - 1] !== "separator") {
        menuItems.push("separator");
      }
      menuItems.push({
        label: strings.grid.menu[a],
        onSelect: () => runAction(a, menu.row, menu.col),
      });
    }
  }

  const failure = (() => {
    if (!pending) return null;
    if (pending.error) return strings.grid.commitFailed(pending.error);
    const list = store().changeList(tabId);
    const i = list.findIndex((c) => pending.errors[c.id] !== undefined);
    return i < 0 ? null : strings.grid.changeFailed(i + 1, pending.errors[list[i].id]);
  })();

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
      {readOnly && (
        <div role="status" className="border-b border-border bg-surface px-3 py-1 text-sm text-muted">
          {readOnly}
        </div>
      )}
      {editable && (
        <div className="flex items-center gap-3 border-b border-border bg-surface px-3 py-1 text-sm">
          <button
            type="button"
            className={btn}
            onClick={() => store().addInsert(tabId)}
            disabled={committing}
          >
            {strings.grid.addRow}
          </button>
          <button
            type="button"
            className={btn}
            onClick={commit}
            disabled={count === 0 || committing}
          >
            {committing ? strings.grid.committing : strings.grid.commit(modShortcut("S"))}
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => store().discard(tabId)}
            disabled={count === 0 || committing}
          >
            {strings.grid.discard}
          </button>
          {count > 0 && <span>{strings.grid.pendingCount(count)}</span>}
          {hint && <span className="ml-auto truncate text-muted">{hint}</span>}
        </div>
      )}
      {failure && (
        <div role="alert" className="border-b border-border px-3 py-1 text-sm text-danger">
          <p className="break-words">{failure}</p>
          <p className="text-muted">{strings.grid.nothingWritten}</p>
        </div>
      )}
      {blocked && count > 0 && (
        <div role="status" className="border-b border-border px-3 py-1 text-sm text-warning">
          {strings.grid.commitOrDiscardFirst}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {t.result && (
          <DataGrid data={t.result} sort={t.sort} onSort={t.setSort} editing={editing} />
        )}
      </div>
      {menu && menuItems.length > 0 && (
        <GridContextMenu
          x={menu.x}
          y={menu.y}
          label={strings.grid.menuLabel}
          items={menuItems}
          onClose={() => setMenu(null)}
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
