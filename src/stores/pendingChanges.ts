import { create } from "zustand";
import { matchesOriginal } from "../features/grid/editing";
import { isConfirmationRequired, parseConfirmationIndices, toAppError } from "../lib/errors";
import * as ipc from "../lib/ipc";
import { dict, hasKey } from "../lib/records";
import { strings } from "../lib/strings";
import type { AppError, CellValue, EditValue, ObjectRef, RowChange, RowKey } from "../lib/types";

export interface PendingEdit {
  key: RowKey;
  /** Columns changed, in the order they were first changed (null prototype). */
  set: Record<string, EditValue>;
  /** The row as loaded. */
  original: CellValue[];
}

export interface PendingInsert {
  tempId: string;
  /**
   * Columns given a value; the others get their default (omitted from the INSERT).
   * Null prototype: a column may be named `__proto__` or `constructor`.
   */
  values: Record<string, EditValue>;
}

export interface PendingTab {
  edits: Record<string, PendingEdit>;
  inserts: PendingInsert[];
  deletes: Record<string, RowKey>;
  /** Apply failure per change id (see changeList), until that change is touched. */
  errors: Record<string, string>;
  /** Apply failure not tied to one change (the commit itself, a cancel). */
  error: string | null;
  /**
   * The last commit lost its connection: some or all changes may have been written. The
   * changes stay, but no commit is sent until a page loaded after it (a reload) settles.
   */
  outcomeUnknown: boolean;
  /**
   * The table the changes belong to: set by the first change, null when nothing is
   * pending. Changes and commits for another table are refused (a table tab can show
   * another table after a foreign key jump).
   */
  object: ObjectRef | null;
}

export interface ChangeEntry {
  /** `update:<rowKeyId>`, `insert:<tempId>` or `delete:<rowKeyId>`. */
  id: string;
  change: RowChange;
}

/**
 * A commit a protected connection refused until confirmed (nothing was written). Run
 * resends exactly `list` (Ruling R10: the confirmation is not bound to the content).
 */
export interface CommitConfirm {
  workspaceId: string;
  object: ObjectRef;
  /** The changes as they were sent and previewed. */
  list: ChangeEntry[];
  /** One SQL text per change of `list` (a fresh changes_preview of it). */
  statements: string[];
  /** Indices (into `list`) the backend wants confirmed. */
  flagged: number[];
}

export const rowKeyId = (key: RowKey) => JSON.stringify(key);

const EMPTY: PendingTab = {
  edits: {},
  inserts: [],
  deletes: {},
  errors: {},
  error: null,
  outcomeUnknown: false,
  object: null,
};

/** Commit errors after which the outcome is unknown (COMMIT may have been sent). */
const UNKNOWN_OUTCOME = new Set(["connectionLost", "connection", "io"]);

const sameObject = (a: ObjectRef, b: ObjectRef) => a.schema === b.schema && a.name === b.name;

interface PendingState {
  tabs: Record<string, PendingTab>;
  /** A page/sort/filter change was refused while changes were pending (cleared with them). */
  blocked: Record<string, boolean>;
  /** A commit is running: the grid is locked and every mutation below is refused. */
  committing: Record<string, boolean>;
  /** The tab committing in each workspace (by workspace id): one at a time per workspace. */
  committingIn: Record<string, string>;
  /** A commit waiting for the user's confirmation: locked like `committing` meanwhile. */
  confirming: Record<string, CommitConfirm>;
  /**
   * A commit succeeded and the page shown predates it: locked like `committing` until a
   * page requested after the commit settles (pageSettled).
   */
  awaitingReload: Record<string, boolean>;
  /** Bumped when a commit ends with a page to reload (success, unknown outcome). */
  epoch: Record<string, number>;
  /**
   * Bumped by every successful commit, and by a Discard after an unknown outcome: the tab
   * reloads its page and count.
   */
  applied: Record<string, number>;
  /** The grid's cell editor is open (Mod+S waits until it is closed). */
  editorOpen: Record<string, boolean>;
  setEditorOpen: (tabId: string, open: boolean) => void;
  // The mutations return false (addInsert: null) while a commit runs, and those taking an
  // `object` also when the tab's changes belong to another table: nothing changes then.
  /** `original`/`columns` = the loaded row, to drop the edit when the value comes back. */
  setCell: (
    tabId: string,
    object: ObjectRef,
    key: RowKey,
    column: string,
    value: EditValue,
    original: CellValue[],
    columns: string[],
  ) => boolean;
  revertCell: (tabId: string, key: RowKey, column: string) => boolean;
  /** A new row (all defaults), or a duplicate when `values` is given; returns its temp id. */
  addInsert: (tabId: string, object: ObjectRef, values?: Readonly<Record<string, EditValue>>) => string | null;
  /** `default` removes the column from the insert. */
  setInsertCell: (tabId: string, tempId: string, column: string, value: EditValue) => boolean;
  removeInsert: (tabId: string, tempId: string) => boolean;
  /** Deleting drops the row's edits; deleting again restores the row (without them). */
  toggleDelete: (tabId: string, object: ObjectRef, key: RowKey) => boolean;
  revertChange: (tabId: string, changeId: string) => boolean;
  /**
   * Drops every change. After a commit with an unknown outcome the tab stays blocked
   * (`outcomeUnknown` and its message are kept) and its page is reloaded.
   */
  discard: (tabId: string) => boolean;
  /** The tab is gone: forget everything about it (allowed during a commit). */
  drop: (tabId: string) => void;
  /** Updates, then inserts, then deletes (the order the backend applies them). */
  changeList: (tabId: string) => ChangeEntry[];
  toChanges: (tabId: string) => RowChange[];
  count: (tabId: string) => number;
  /** True when nothing is pending; else flags the tab (strings.grid.commitOrDiscardFirst). */
  guardPending: (tabId: string) => boolean;
  /** guardPending, but a reload is also allowed after a commit with an unknown outcome. */
  guardReload: (tabId: string) => boolean;
  /** The tab's commit epoch: read when a page request starts, passed to pageSettled. */
  epochOf: (tabId: string) => number;
  /**
   * A page request started at `epoch` settled (`ok`: loaded). If it started after the last
   * commit ended it unlocks the tab, and a loaded page clears `outcomeUnknown`.
   */
  pageSettled: (tabId: string, epoch: number, ok: boolean) => void;
  /** Asks the backend to cancel the tab's running commit (no-op when none runs). */
  cancelCommit: (tabId: string, workspaceId: string) => Promise<void>;
  /**
   * Applies every change in one transaction (never two at once for a tab); refused (false,
   * tab error) when the changes belong to another table than `object`, or while the last
   * commit's outcome is unknown. Success: discard + `applied` bump + locked until the
   * reload lands, true. Failure: nothing is removed, the failing change (or the tab) gets
   * the message, false; a lost connection sets `outcomeUnknown` instead of claiming that
   * nothing was written. Refused too while another tab of the workspace commits. A
   * protected connection asking for confirmation fills `confirming` (false, no error).
   */
  commit: (tabId: string, workspaceId: string, object: ObjectRef) => Promise<boolean>;
  /**
   * Run in the confirmation: resends exactly the confirmed list, confirmed. Refused (the
   * confirmation closes, tab error) while another tab of the workspace commits.
   */
  confirmCommit: (tabId: string) => Promise<boolean>;
  /** Cancel in the confirmation: nothing is applied, the changes stay pending. */
  cancelConfirm: (tabId: string) => void;
}

let insertSeq = 0;

/** `change 3: reason` (changes_apply / changes_preview refusing a change before running). */
const REFUSED = /^change (\d+): ([\s\S]*)$/;

/**
 * The change an `invalid` "change <i>: <reason>" refusal names (0-based index in the
 * list sent), else null.
 */
export function refusedChange(err: AppError): { index: number; reason: string } | null {
  const m = err.kind === "invalid" ? REFUSED.exec(err.message) : null;
  return m ? { index: Number(m[1]), reason: m[2] } : null;
}

export const usePendingChanges = create<PendingState>((set, get) => {
  const tab = (tabId: string) => get().tabs[tabId] ?? EMPTY;
  const locked = (tabId: string) =>
    get().committing[tabId] === true ||
    get().awaitingReload[tabId] === true ||
    get().confirming[tabId] !== undefined;
  /** The tab's changes belong to `object` (or nothing is pending). */
  const sameTable = (tabId: string, object: ObjectRef) => {
    const bound = tab(tabId).object;
    return bound === null || sameObject(bound, object);
  };
  /**
   * Applies `fn` to the tab, clearing the error of `touched` changes and the tab error.
   * Refused (false) while a commit runs, or when `object` is given and the tab's changes
   * belong to another table; else `object` becomes the tab's table. An empty tab has none.
   */
  const update = (
    tabId: string,
    touched: string[],
    fn: (t: PendingTab) => PendingTab,
    object?: ObjectRef,
  ) => {
    if (locked(tabId) || (object && !sameTable(tabId, object))) return false;
    set((s) => {
      const next = fn(s.tabs[tabId] ?? EMPTY);
      const errors = { ...next.errors };
      for (const id of touched) delete errors[id];
      const empty = changeCount(next) === 0;
      const bound = empty ? null : (next.object ?? object ?? null);
      const tabs = { ...s.tabs, [tabId]: { ...next, errors, error: null, object: bound } };
      return { tabs, blocked: empty ? { ...s.blocked, [tabId]: false } : s.blocked };
    });
    return true;
  };
  /** Nothing pending; an unknown outcome (and its message) stays until a reload settles. */
  const clear = (tabId: string) =>
    set((s) => {
      const t = s.tabs[tabId];
      const next = t?.outcomeUnknown ? { ...EMPTY, outcomeUnknown: true, error: t.error } : EMPTY;
      return {
        tabs: { ...s.tabs, [tabId]: next },
        blocked: { ...s.blocked, [tabId]: false },
      };
    });
  const omitConfirm = (tabId: string) =>
    set((s) => {
      if (s.confirming[tabId] === undefined) return s;
      const confirming = { ...s.confirming };
      delete confirming[tabId];
      return { confirming };
    });

  /**
   * Sends `list` (the tab's changes, checked by the caller) in one transaction and handles
   * the outcome; see `commit`.
   */
  const apply = async (
    tabId: string,
    workspaceId: string,
    object: ObjectRef,
    list: ChangeEntry[],
    confirmed: boolean,
  ): Promise<boolean> => {
    const changes = list.map((c) => c.change);
    // The tab may be closed (dropped) while the commit runs: then nothing is written back.
    const gone = () => get().tabs[tabId] === undefined;
    const setCommitting = (on: boolean) =>
      set((s) => {
        if (gone()) return s;
        const committingIn = { ...s.committingIn };
        if (on) committingIn[workspaceId] = tabId;
        else if (committingIn[workspaceId] === tabId) delete committingIn[workspaceId];
        return { committing: { ...s.committing, [tabId]: on }, committingIn };
      });
    const fail = (changeId: string | null, message: string) =>
      set((s) => {
        const t = s.tabs[tabId];
        if (!t) return s;
        return {
          tabs: {
            ...s.tabs,
            [tabId]: changeId
              ? { ...t, errors: { [changeId]: message }, error: null }
              : { ...t, errors: {}, error: message },
          },
        };
      });
    /** An `invalid` "change <i>: …" marks that change, anything else the tab. */
    const failWith = (err: AppError, message: string) => {
      const refused = refusedChange(err);
      const entry = refused ? list[refused.index] : undefined;
      if (refused && entry) fail(entry.id, refused.reason);
      else fail(null, message);
    };
    setCommitting(true);
    try {
      const outcome = await ipc.changesApply(workspaceId, object, changes, confirmed);
      if (outcome.applied) {
        if (gone()) return true;
        clear(tabId);
        // Locked until the reload of the committed page lands (no edit on the old page).
        set((s) => ({
          applied: { ...s.applied, [tabId]: (s.applied[tabId] ?? 0) + 1 },
          awaitingReload: { ...s.awaitingReload, [tabId]: true },
          epoch: { ...s.epoch, [tabId]: (s.epoch[tabId] ?? 0) + 1 },
        }));
        return true;
      }
      const failed = outcome.failedIndex === null ? null : (list[outcome.failedIndex]?.id ?? null);
      fail(failed, outcome.error?.message ?? strings.unknownError);
      return false;
    } catch (e) {
      const err = toAppError(e);
      // Checked first: nothing was built or written, so this is no failure. The statements
      // shown come from a fresh preview of the very list sent (the panel's may be stale).
      if (!confirmed && isConfirmationRequired(err)) {
        if (gone()) return false;
        let statements: string[];
        try {
          statements = await ipc.changesPreview(workspaceId, object, changes);
        } catch (pe) {
          const perr = toAppError(pe);
          failWith(perr, strings.grid.confirmPreviewFailed(perr.message));
          return false;
        }
        if (gone()) return false;
        // One SQL per change, or the flags and the SQL shown would not match the changes sent.
        if (statements.length !== list.length) {
          fail(null, strings.grid.confirmPreviewFailed(strings.grid.previewCountMismatch(statements.length, list.length)));
          return false;
        }
        const flagged = parseConfirmationIndices(err.message, list.length);
        set((s) => ({
          confirming: { ...s.confirming, [tabId]: { workspaceId, object, list, statements, flagged } },
        }));
        return false;
      }
      if (err.kind === "cancelled") {
        fail(null, strings.grid.commitCancelled);
        return false;
      }
      if (UNKNOWN_OUTCOME.has(err.kind)) {
        set((s) => {
          const t = s.tabs[tabId];
          if (!t) return s;
          return {
            tabs: { ...s.tabs, [tabId]: { ...t, errors: {}, error: err.message, outcomeUnknown: true } },
            epoch: { ...s.epoch, [tabId]: (s.epoch[tabId] ?? 0) + 1 },
          };
        });
        return false;
      }
      failWith(err, err.message);
      return false;
    } finally {
      setCommitting(false);
    }
  };

  return {
    tabs: {},
    blocked: {},
    committing: {},
    committingIn: {},
    confirming: {},
    awaitingReload: {},
    epoch: {},
    applied: {},
    editorOpen: {},

    setEditorOpen: (tabId, open) =>
      set((s) => ({ editorOpen: { ...s.editorOpen, [tabId]: open } })),

    setCell: (tabId, object, key, column, value, original, columns) => {
      const id = rowKeyId(key);
      if (tab(tabId).deletes[id]) return false;
      return update(tabId, [`update:${id}`], (t) => {
        const prev = t.edits[id];
        const setCols = dict(prev?.set);
        const orig = prev?.original ?? original;
        const at = columns.indexOf(column);
        if (at >= 0 && orig[at] && matchesOriginal(value, orig[at])) delete setCols[column];
        else setCols[column] = value;
        const edits = { ...t.edits };
        if (Object.keys(setCols).length === 0) delete edits[id];
        else edits[id] = { key, set: setCols, original: orig };
        return { ...t, edits };
      }, object);
    },

    revertCell: (tabId, key, column) => {
      const id = rowKeyId(key);
      return update(tabId, [`update:${id}`], (t) => {
        const prev = t.edits[id];
        if (!prev || !hasKey(prev.set, column)) return t;
        const setCols = dict(prev.set);
        delete setCols[column];
        const edits = { ...t.edits };
        if (Object.keys(setCols).length === 0) delete edits[id];
        else edits[id] = { ...prev, set: setCols };
        return { ...t, edits };
      });
    },

    addInsert: (tabId, object, values) => {
      const tempId = `new-${++insertSeq}`;
      const ok = update(
        tabId,
        [],
        (t) => ({ ...t, inserts: [...t.inserts, { tempId, values: dict(values) }] }),
        object,
      );
      return ok ? tempId : null;
    },

    setInsertCell: (tabId, tempId, column, value) =>
      update(tabId, [`insert:${tempId}`], (t) => ({
        ...t,
        inserts: t.inserts.map((i) => {
          if (i.tempId !== tempId) return i;
          const values = dict(i.values);
          if (value.t === "default") delete values[column];
          else values[column] = value;
          return { ...i, values };
        }),
      })),

    removeInsert: (tabId, tempId) =>
      update(tabId, [`insert:${tempId}`], (t) => ({
        ...t,
        inserts: t.inserts.filter((i) => i.tempId !== tempId),
      })),

    toggleDelete: (tabId, object, key) => {
      const id = rowKeyId(key);
      return update(tabId, [`delete:${id}`, `update:${id}`], (t) => {
        const deletes = { ...t.deletes };
        const edits = { ...t.edits };
        if (deletes[id]) delete deletes[id];
        else {
          deletes[id] = key;
          delete edits[id];
        }
        return { ...t, deletes, edits };
      }, object);
    },

    revertChange: (tabId, changeId) => {
      const sep = changeId.indexOf(":");
      const kind = changeId.slice(0, sep);
      const ref = changeId.slice(sep + 1);
      return update(tabId, [changeId], (t) => {
        if (kind === "update") {
          const edits = { ...t.edits };
          delete edits[ref];
          return { ...t, edits };
        }
        if (kind === "delete") {
          const deletes = { ...t.deletes };
          delete deletes[ref];
          return { ...t, deletes };
        }
        return { ...t, inserts: t.inserts.filter((i) => i.tempId !== ref) };
      });
    },

    discard: (tabId) => {
      if (locked(tabId)) return false;
      const unknown = tab(tabId).outcomeUnknown;
      clear(tabId);
      // The page shown may predate what the lost commit wrote: reload it to check.
      if (unknown) set((s) => ({ applied: { ...s.applied, [tabId]: (s.applied[tabId] ?? 0) + 1 } }));
      return true;
    },

    drop: (tabId) =>
      set((s) => {
        const omit = <T,>(r: Record<string, T>) => {
          const c = { ...r };
          delete c[tabId];
          return c;
        };
        const committingIn = Object.fromEntries(
          Object.entries(s.committingIn).filter(([, t]) => t !== tabId),
        );
        return {
          tabs: omit(s.tabs),
          blocked: omit(s.blocked),
          committing: omit(s.committing),
          committingIn,
          confirming: omit(s.confirming),
          awaitingReload: omit(s.awaitingReload),
          epoch: omit(s.epoch),
          applied: omit(s.applied),
          editorOpen: omit(s.editorOpen),
        };
      }),

    changeList: (tabId) => {
      const t = tab(tabId);
      return [
        ...Object.entries(t.edits).map(([id, e]) => ({
          id: `update:${id}`,
          change: { kind: "update", key: e.key, set: Object.entries(e.set) } as RowChange,
        })),
        ...t.inserts.map((i) => ({
          id: `insert:${i.tempId}`,
          change: { kind: "insert", values: Object.entries(i.values) } as RowChange,
        })),
        ...Object.entries(t.deletes).map(([id, key]) => ({
          id: `delete:${id}`,
          change: { kind: "delete", key } as RowChange,
        })),
      ];
    },

    toChanges: (tabId) => get().changeList(tabId).map((c) => c.change),

    count: (tabId) => changeCount(tab(tabId)),

    guardPending: (tabId) => {
      if (get().count(tabId) === 0) return true;
      set((s) => ({ blocked: { ...s.blocked, [tabId]: true } }));
      return false;
    },

    guardReload: (tabId) => tab(tabId).outcomeUnknown || get().guardPending(tabId),

    epochOf: (tabId) => get().epoch[tabId] ?? 0,

    pageSettled: (tabId, epoch, ok) => {
      if (epoch !== get().epochOf(tabId)) return;
      set((s) => {
        const t = s.tabs[tabId];
        const tabs =
          ok && t?.outcomeUnknown ? { ...s.tabs, [tabId]: { ...t, outcomeUnknown: false, error: null } } : s.tabs;
        return { tabs, awaitingReload: { ...s.awaitingReload, [tabId]: false } };
      });
    },

    cancelCommit: async (tabId, workspaceId) => {
      if (get().committing[tabId] !== true) return;
      await ipc.changesCancel(workspaceId);
    },

    commit: async (tabId, workspaceId, object) => {
      if (locked(tabId) || tab(tabId).outcomeUnknown) return false;
      const list = get().changeList(tabId);
      if (list.length === 0) return true;
      const bound = tab(tabId).object;
      const refuse = (error: string) => {
        set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...tab(tabId), errors: {}, error } } }));
        return false;
      };
      if (bound && !sameObject(bound, object)) return refuse(strings.grid.otherTableChanges(bound.name));
      const other = get().committingIn[workspaceId];
      if (other !== undefined && other !== tabId) return refuse(strings.grid.otherTabCommitting);
      return apply(tabId, workspaceId, object, list, false);
    },

    confirmCommit: async (tabId) => {
      const c = get().confirming[tabId];
      if (!c || get().committing[tabId] === true) return false;
      omitConfirm(tabId);
      // Another tab of the workspace started committing meanwhile: close and say why.
      const other = get().committingIn[c.workspaceId];
      if (other !== undefined && other !== tabId) {
        set((s) => ({ tabs: { ...s.tabs, [tabId]: { ...tab(tabId), errors: {}, error: strings.grid.otherTabCommitting } } }));
        return false;
      }
      return apply(tabId, c.workspaceId, c.object, c.list, true);
    },

    cancelConfirm: (tabId) => omitConfirm(tabId),
  };
});

function changeCount(t: PendingTab): number {
  return Object.keys(t.edits).length + t.inserts.length + Object.keys(t.deletes).length;
}

/**
 * Page, sort and filter changes call this first: true when the tab has nothing pending,
 * else it refuses and the tab shows strings.grid.commitOrDiscardFirst.
 */
export const guardPending = (tabId: string) => usePendingChanges.getState().guardPending(tabId);
