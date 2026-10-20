import { useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { EditValue, ObjectRef, ResultSet } from "../../lib/types";
import { usePendingChanges } from "../../stores/pendingChanges";
import { effectiveShortcut } from "../../lib/keymap";
import { useSettings } from "../../stores/settings";
import type { GridEditing, RowsAction } from "./DataGrid";
import { buildGridModel, type GridModel, type MenuAction, menuActions } from "./editModel";
import { cellText, insertValuesOf, parseEditorInput, readOnlyReason } from "./editing";
import type { MenuItem } from "./GridContextMenu";
import { blockAt, type CellBlock } from "./gridSelection";
import { useTableInfo } from "./useTableInfo";

/**
 * A display row by identity (display indexes move with inserts, reloads and pages): an
 * insert's temp id, a loaded row's key, else its index in that very page.
 */
export type RowRef = { tempId: string } | { keyId: string } | { index: number; page: ResultSet };

export function refOf(model: GridModel, row: number, page: ResultSet): RowRef | null {
  const r = model.rows[row];
  if (!r) return null;
  if (r.kind === "insert") return { tempId: r.tempId };
  return r.keyId !== null ? { keyId: r.keyId } : { index: r.index, page };
}

/** Where the record is now in `model` (null: gone, or another page). */
export function rowOf(model: GridModel | null, ref: RowRef | null, page: ResultSet | null): number | null {
  if (!model || !ref) return null;
  if ("page" in ref && ref.page !== page) return null;
  const i = model.rows.findIndex((r) =>
    "tempId" in ref
      ? r.kind === "insert" && r.tempId === ref.tempId
      : "keyId" in ref
        ? r.kind === "row" && r.keyId === ref.keyId
        : r.kind === "row" && r.index === ref.index,
  );
  return i < 0 ? null : i;
}

/** A display row's identity as a string (for the grid, which keeps it across renders). */
const idOf = (ref: RowRef | null) =>
  ref === null ? null : "tempId" in ref ? `i:${ref.tempId}` : "keyId" in ref ? `k:${ref.keyId}` : `p:${ref.index}`;

/** Numbers each loaded page, so a signature tells two loads of the same rows apart. */
const pageIds = new WeakMap<ResultSet, number>();
let pageSeq = 0;
const pageId = (page: ResultSet) => {
  let id = pageIds.get(page);
  if (id === undefined) pageIds.set(page, (id = ++pageSeq));
  return id;
};

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
  const awaitingReload = usePendingChanges((s) => s.awaitingReload[tabId] ?? false);
  /** A commit the protected connection wants confirmed (the tab shows the dialog). */
  const confirm = usePendingChanges((s) => s.confirming[tabId] ?? null);
  const appliedSeq = usePendingChanges((s) => s.applied[tabId] ?? 0);
  /** Edits are refused: a commit runs, waits for its confirmation, or its reload has not landed. */
  const locked = committing || awaitingReload || confirm !== null;
  /**
   * The open context menu, bound to its record (and the rows of its copy block) by
   * identity: it follows the record when rows are added above it, and closes when the
   * record is gone, the page is reloaded or a commit starts.
   */
  const [menuAt, setMenuAt] = useState<{
    ref: RowRef;
    col: number | null;
    x: number;
    y: number;
    /** The page it was opened on. */
    page: ResultSet;
    /** What the menu's copy entries copy: rows by identity, columns by index. */
    blockRows: (RowRef | null)[];
    blockCols: number[];
  } | null>(null);
  /** Why the cell the user tried to edit is read-only, or a failed load. */
  const [hint, setHint] = useState<string | null>(null);
  /**
   * The grid's selected record, by identity (display indexes move with inserts, reloads and
   * pages): an insert's temp id, a loaded row's key, else its index in that very page.
   */
  const [selected, setSelected] = useState<RowRef | null>(null);

  const editable = info !== null && readOnlyReason(info) === null;
  const readOnly = infoError
    ? strings.grid.infoFailed(infoError.message)
    : info
      ? readOnlyReason(info)
      : null;

  // False once unmounted: the tab may show another table by then (the table view is keyed
  // by its object), so a load that finishes late must not add a change for it.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A successful commit (from the toolbar or Mod+S) reloads the page and the count.
  const seenApplied = useRef(appliedSeq);
  useEffect(() => {
    if (appliedSeq === seenApplied.current) return;
    seenApplied.current = appliedSeq;
    reload();
  }, [appliedSeq, reload]);

  const model = useMemo(
    () => (result ? buildGridModel(result, info, pending, locked) : null),
    [result, info, pending, locked],
  );
  /** Identity of every display row (with the page and the lock: the row signature). */
  const rowIds = useMemo(
    () => (model && result ? model.rows.map((_, i) => idOf(refOf(model, i, result))) : []),
    [model, result],
  );
  // The latest model, page and row ids, for actions resolving a record captured earlier.
  const latest = useRef({ model, result, rowIds });
  latest.current = { model, result, rowIds };
  const rowSignature = result ? `${pageId(result)}|${locked ? 1 : 0}|${rowIds.join("\u0000")}` : "";

  const store = usePendingChanges.getState;
  const duplicateKey = useSettings((st) => effectiveShortcut("grid.duplicateRows", st.settings.keymap));
  const deleteKey = useSettings((st) => effectiveShortcut("grid.deleteRows", st.settings.keymap));

  const selectedRow = rowOf(model, selected, result);

  const select = (row: number | null) => {
    setSelected(row === null || !model || !result ? null : refOf(model, row, result));
  };

  const setValue = (row: number, col: number, value: EditValue) => {
    const { model, result } = latest.current;
    const r = model?.rows[row];
    const name = model?.columns[col];
    if (!model || !r || name === undefined || !result) return;
    if (r.kind === "insert") store().setInsertCell(tabId, r.tempId, name, value);
    else if (r.key) store().setCell(tabId, object, r.key, name, value, result.rows[r.index], model.columns);
  };

  const loadFull = async (row: number, col: number) => {
    const { model } = latest.current;
    const key = model?.rowKeyAt(row);
    const name = model?.columns[col];
    if (!key || name === undefined) throw { kind: "invalid", message: strings.grid.nullKey };
    return cellText(await ipc.cellValue(workspaceId, object, key, name));
  };

  /** A new row with what the user sees in `row` (pending values over the loaded ones). */
  const duplicate = async (row: number) => {
    const { model, result } = latest.current;
    const r = model?.rows[row];
    if (!model || !r || !info || !result) return;
    if (r.kind === "insert") {
      store().addInsert(tabId, object, r.values);
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
      if (live.current) setHint(strings.grid.editorLoadFailed(toAppError(e).message));
      return;
    }
    if (live.current) store().addInsert(tabId, object, values);
  };

  const runAction = (a: MenuAction, row: number, col: number | null) => {
    const { model } = latest.current;
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
        else if (r.key) store().toggleDelete(tabId, object, r.key);
        break;
    }
  };

  /** A menu action on the record the menu was opened on, wherever it is now (no-op if gone). */
  const runActionOn = (a: MenuAction, ref: RowRef, col: number | null) => {
    const { model, result } = latest.current;
    const row = rowOf(model, ref, result);
    if (row !== null && !model?.locked) runAction(a, row, col);
  };

  /**
   * Delete (or Restore, when every row that can be deleted already is) `rows`: new rows are
   * dropped, loaded rows marked for deletion. Pending changes only: a commit writes them.
   */
  const deleteRows = (rows: number[]) => {
    const { model } = latest.current;
    if (!model || model.locked || !editable) return;
    const targets = rows
      .map((r) => model.rows[r])
      .filter((r): r is NonNullable<typeof r> => r !== undefined && (r.kind === "insert" || r.key !== null));
    const restoring = targets.length > 0 && targets.every((r) => r.kind === "row" && r.deleted);
    for (const r of targets) {
      if (r.kind === "insert") {
        if (!restoring) store().removeInsert(tabId, r.tempId);
      } else if (r.key && r.deleted === restoring) {
        store().toggleDelete(tabId, object, r.key);
      }
    }
  };

  /** The grid keys on the selected rows: Delete / grid.deleteRows, grid.duplicateRows. */
  const rowsAction = (action: RowsAction, rows: number[]) => {
    const { model, result } = latest.current;
    if (!model || model.locked || !editable) return;
    if (action === "delete") {
      deleteRows(rows);
      return;
    }
    // One after the other, in row order (a row whose values must load first would otherwise
    // land after the next ones), each record found again by identity: new rows move the others.
    const refs = result ? rows.map((r) => refOf(model, r, result)) : [];
    void (async () => {
      for (const ref of refs) {
        const { model: m, result: page } = latest.current;
        const row = rowOf(m, ref, page);
        if (row === null || !live.current) return;
        await duplicate(row);
      }
    })();
  };

  // Where the menu's record is now; the menu closes once it is gone, reloaded or locked.
  const menuRow = menuAt && menuAt.page === result && !locked ? rowOf(model, menuAt.ref, result) : null;
  const menuOpen = menuAt !== null && menuRow !== null;
  useEffect(() => {
    if (menuAt && !menuOpen) setMenuAt(null);
  }, [menuAt, menuOpen]);

  /** The grid's editing hooks; the tab adds the foreign key links. */
  const editing: Omit<GridEditing, "linkAt" | "onOpenLink"> | undefined = model
    ? {
        model,
        onEdit: (row, col, text) => setValue(row, col, parseEditorInput(text, {})),
        loadFull,
        onContextMenu: (row, col, x, y, selection) => {
          const ref = result ? refOf(model, row, result) : null;
          if (!ref || !result) return;
          const block = blockAt(selection ?? null, row, col, model.columns.length);
          setMenuAt({
            ref,
            col,
            x,
            y,
            page: result,
            blockRows: block.rows.map((r) => refOf(model, r, result)),
            blockCols: block.cols,
          });
        },
        onActivate: (row, col) => setHint(model.cell(row, col).reason),
        onEditorOpen: (open) => store().setEditorOpen(tabId, open),
        selectedRow,
        onSelect: select,
        rowSignature,
        rowIdAt: (row) => rowIds[row] ?? null,
        rowById: (id) => {
          const i = latest.current.rowIds.indexOf(id);
          return i < 0 ? null : i;
        },
      }
    : undefined;

  /** The menu's block rows (by identity) where they are now. */
  const menuBlockRows = (): number[] =>
    menuAt
      ? menuAt.blockRows.map((r) => rowOf(model, r, result)).filter((r): r is number => r !== null)
      : [];

  /**
   * The cell menu's editing entries: why the cell is read-only, the Set value group (NULL /
   * EMPTY / DEFAULT, Revert, on every selected cell that takes it) and the row group (Add
   * row, Duplicate, Delete / Restore, on every selected row).
   */
  const reasonItems: MenuItem[] = [];
  const setValueItems: MenuItem[] = [];
  const rowItems: MenuItem[] = [];
  if (menuAt && menuRow !== null && model) {
    const { ref, col } = menuAt;
    const reason = col !== null ? model.cell(menuRow, col).reason : null;
    if (reason) reasonItems.push({ label: reason, disabled: true, onSelect: () => {} });
    const actions = menuActions(model, menuRow, col);
    const blockRefs = menuAt.blockRows;
    const blockCols = menuAt.blockCols;
    /** Runs `a` on every cell of the block that takes it (the record of each by identity). */
    const onBlock = (a: MenuAction) => () => {
      for (const rref of blockRefs) {
        const { model: m, result: page } = latest.current;
        const r = rowOf(m, rref, page);
        if (r === null || !m || m.locked) continue;
        for (const c of blockCols) if (menuActions(m, r, c).includes(a)) runAction(a, r, c);
      }
    };
    const cellEntry = (a: MenuAction, label: string, ariaLabel?: string): MenuItem => ({
      label,
      ariaLabel,
      indent: true,
      onSelect: col === null ? () => runActionOn(a, ref, col) : onBlock(a),
    });
    const values: MenuItem[] = [];
    if (actions.includes("setNull")) values.push(cellEntry("setNull", strings.grid.nullText, strings.grid.menu.setNull));
    if (actions.includes("setEmpty")) values.push(cellEntry("setEmpty", strings.grid.emptyText, strings.grid.menu.setEmpty));
    if (actions.includes("setDefault")) {
      values.push(cellEntry("setDefault", strings.grid.defaultText, strings.grid.menu.setDefault));
    }
    if (values.length > 0) setValueItems.push({ heading: strings.grid.menu.setValue }, ...values);
    if (actions.includes("revertCell")) {
      setValueItems.push({ label: strings.grid.menu.revertCell, onSelect: onBlock("revertCell") });
    }
    if (actions.includes("duplicateRow")) {
      const rows = menuBlockRows();
      const n = Math.max(1, rows.length);
      const deletable = rows.map((r) => model.rows[r]).filter((r) => r && (r.kind === "insert" || r.key !== null));
      const restoring = deletable.length > 0 && deletable.every((r) => r?.kind === "row" && r.deleted);
      rowItems.push(
        { label: strings.grid.menu.addRow, onSelect: () => store().addInsert(tabId, object) },
        {
          label: n === 1 ? strings.grid.menu.duplicateRow : strings.grid.menu.duplicateRows(n),
          shortcut: duplicateKey,
          onSelect: () => rowsAction("duplicate", menuBlockRows()),
        },
      );
      if (deletable.length > 0) {
        const m = deletable.length;
        rowItems.push({
          label: restoring
            ? m === 1
              ? strings.grid.menu.restoreRow
              : strings.grid.menu.restoreRows(m)
            : m === 1
              ? strings.grid.menu.deleteRow
              : strings.grid.menu.deleteRows(m),
          shortcut: restoring ? undefined : deleteKey,
          onSelect: () => deleteRows(menuBlockRows()),
        });
      }
    }
  }

  const outcomeUnknown = pending?.outcomeUnknown ?? false;
  const failure = (() => {
    if (!pending) return null;
    if (outcomeUnknown) return strings.grid.commitOutcomeUnknown;
    // A refusal is no failure: nothing was attempted, so no "Commit failed:" prefix.
    if (pending.refusal) return pending.refusal;
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
    /** Edits refused (a commit runs or waits for confirmation, or its reload has not landed). */
    locked,
    /** The commit waiting for confirmation, else null. */
    confirm,
    /** The last commit lost its connection: Commit is refused until a reload. */
    outcomeUnknown,
    hint,
    failure,
    /** Where the context menu is (its record's display row now; null: closed). */
    menuTarget:
      menuAt && menuRow !== null && model
        ? {
            row: menuRow,
            col: menuAt.col,
            x: menuAt.x,
            y: menuAt.y,
            block: {
              rows: menuAt.blockRows
                .map((r) => rowOf(model, r, result))
                .filter((r): r is number => r !== null),
              cols: menuAt.blockCols,
            } satisfies CellBlock,
          }
        : null,
    /** Why the clicked cell is read-only (a disabled entry), else nothing. */
    reasonItems,
    /** The Set value group of the cell menu. */
    setValueItems,
    /** Add row, Duplicate and Delete / Restore of the menu. */
    rowItems,
    closeMenu: () => setMenuAt(null),
    /** The grid keys on the selected rows. */
    rowsAction,
    /** Display row selected in the grid (null: none, or the row is gone). */
    selectedRow,
    /** Writes a cell through the store (same rules as the grid's editor). */
    setValue,
    /** A context-menu action on a cell or row. */
    runAction,
    // Commit, Cancel and Discard are the toolbar's (#103), straight on the store.
    addRow: () => store().addInsert(tabId, object),
  };
}
