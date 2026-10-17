import { useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { EditValue, ObjectRef, ResultSet } from "../../lib/types";
import { usePendingChanges } from "../../stores/pendingChanges";
import type { GridEditing } from "./DataGrid";
import { buildGridModel, type MenuAction, menuActions } from "./editModel";
import { cellText, insertValuesOf, parseEditorInput, readOnlyReason } from "./editing";
import type { MenuItem } from "./GridContextMenu";
import { useTableInfo } from "./useTableInfo";

interface Args {
  workspaceId: string;
  tabId: string;
  object: ObjectRef;
  /** The loaded page (null until the first load). */
  result: ResultSet | null;
  /** Reloads the page and the count (after a successful commit). */
  reload: () => void;
}

/**
 * Everything a table tab needs to edit its grid: table metadata, the grid model with the
 * pending changes, the grid's editing callbacks, the context menu, the commit and its
 * errors. Shared by the grid and the panels of the tab.
 */
export function useTableEditing({ workspaceId, tabId, object, result, reload }: Args) {
  const { info, error: infoError } = useTableInfo(workspaceId, object);
  const pending = usePendingChanges((s) => s.tabs[tabId]);
  const count = usePendingChanges((s) => s.count(tabId));
  const blocked = usePendingChanges((s) => s.blocked[tabId] ?? false);
  const committing = usePendingChanges((s) => s.committing[tabId] ?? false);
  const appliedSeq = usePendingChanges((s) => s.applied[tabId] ?? 0);
  const [menuAt, setMenuAt] = useState<{ row: number; col: number | null; x: number; y: number } | null>(
    null,
  );
  /** Why the cell the user tried to edit is read-only, or a failed load. */
  const [hint, setHint] = useState<string | null>(null);

  const editable = info !== null && readOnlyReason(info) === null;
  const readOnly = infoError
    ? strings.grid.infoFailed(infoError.message)
    : info
      ? readOnlyReason(info)
      : null;

  // A successful commit (from the toolbar or Mod+S) reloads the page and the count.
  const seenApplied = useRef(appliedSeq);
  useEffect(() => {
    if (appliedSeq === seenApplied.current) return;
    seenApplied.current = appliedSeq;
    reload();
  }, [appliedSeq, reload]);

  const model = useMemo(
    () => (result ? buildGridModel(result, info, pending, committing) : null),
    [result, info, pending, committing],
  );

  const store = usePendingChanges.getState;

  const setValue = (row: number, col: number, value: EditValue) => {
    const r = model?.rows[row];
    const name = model?.columns[col];
    if (!model || !r || name === undefined || !result) return;
    if (r.kind === "insert") store().setInsertCell(tabId, r.tempId, name, value);
    else if (r.key) store().setCell(tabId, r.key, name, value, result.rows[r.index], model.columns);
  };

  const loadFull = async (row: number, col: number) => {
    const key = model?.rowKeyAt(row);
    const name = model?.columns[col];
    if (!key || name === undefined) throw { kind: "invalid", message: strings.grid.nullKey };
    return cellText(await ipc.cellValue(workspaceId, object, key, name));
  };

  /** A new row with what the user sees in `row` (pending values over the loaded ones). */
  const duplicate = async (row: number) => {
    const r = model?.rows[row];
    if (!model || !r || !info || !result) return;
    if (r.kind === "insert") {
      store().addInsert(tabId, r.values);
      return;
    }
    const { values, truncated } = insertValuesOf(
      info,
      model.columns,
      result.rows[r.index],
      r.edit?.set,
    );
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
        onContextMenu: (row, col, x, y) => setMenuAt({ row, col, x, y }),
        onActivate: (row, col) => setHint(model.cell(row, col).reason),
        onEditorOpen: (open) => store().setEditorOpen(tabId, open),
      }
    : undefined;

  const menuItems: MenuItem[] = [];
  if (menuAt && model) {
    const reason = menuAt.col !== null ? model.cell(menuAt.row, menuAt.col).reason : null;
    if (reason) menuItems.push({ label: reason, disabled: true, onSelect: () => {} }, "separator");
    for (const a of menuActions(model, menuAt.row, menuAt.col)) {
      if (a === "duplicateRow" && menuItems.length > 0 && menuItems[menuItems.length - 1] !== "separator") {
        menuItems.push("separator");
      }
      menuItems.push({
        label: strings.grid.menu[a],
        onSelect: () => runAction(a, menuAt.row, menuAt.col),
      });
    }
  }
  const menu =
    menuAt && menuItems.length > 0
      ? { x: menuAt.x, y: menuAt.y, label: strings.grid.menuLabel, items: menuItems }
      : null;

  const failure = (() => {
    if (!pending) return null;
    if (pending.error) return strings.grid.commitFailed(pending.error);
    const list = store().changeList(tabId);
    const i = list.findIndex((c) => pending.errors[c.id] !== undefined);
    return i < 0 ? null : strings.grid.changeFailed(i + 1, pending.errors[list[i].id]);
  })();

  return {
    info,
    editable,
    /** Why the table is read-only (banner), else null. */
    readOnly,
    model,
    editing,
    count,
    blocked,
    committing,
    hint,
    failure,
    menu,
    closeMenu: () => setMenuAt(null),
    commit: () => void store().commit(tabId, workspaceId, object),
    addRow: () => store().addInsert(tabId),
    discard: () => store().discard(tabId),
  };
}
