import { useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { CellValue, ObjectRef, RowChange, RowKey } from "../../lib/types";
import { type ChangeEntry, refusedChange, usePendingChanges } from "../../stores/pendingChanges";
import { cellText } from "./editing";

interface Props {
  workspaceId: string;
  tabId: string;
  object: ObjectRef;
}

/** Delay between the last change and the SQL preview request. */
export const PREVIEW_DELAY_MS = 200;

const s = strings.grid.changes;

const KIND = {
  update: { label: s.update, badge: "bg-pending-edit" },
  insert: { label: s.insert, badge: "bg-pending-insert" },
  delete: { label: s.delete, badge: "bg-pending-delete" },
} as const;

const btn =
  "rounded-sm border border-border px-2 py-0.5 hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

/** A key value as it reads in SQL: numbers and booleans bare, anything else quoted. */
function keyValueText(v: CellValue): string {
  switch (v.t) {
    case "int":
    case "bigInt":
    case "float":
    case "decimal":
    case "bool":
      return cellText(v);
    default:
      return s.quoted(cellText(v));
  }
}

/** `id = 42, name = 'a, b'`. */
const keyText = (key: RowKey) =>
  key.map(([column, value]) => s.keyPart(column, keyValueText(value))).join(s.keySeparator);

/** The row a change targets, and the columns it sets. */
function describe(change: RowChange): { target: string; columns: string | null } {
  switch (change.kind) {
    case "update":
      return {
        target: keyText(change.key),
        columns: change.set.map(([c]) => c).join(s.columnSeparator),
      };
    case "insert":
      return {
        target: s.newRow,
        columns:
          change.values.length > 0 ? change.values.map(([c]) => c).join(s.columnSeparator) : s.allDefaults,
      };
    case "delete":
      return { target: keyText(change.key), columns: null };
  }
}

interface Preview {
  /** Each change id as it was asked (JSON): a line that changed since shows nothing. */
  asked: Record<string, string>;
  /** SQL per change id. */
  sql: Record<string, string>;
  /** The change changes_preview refused, with the reason. */
  invalid: Record<string, string>;
  /** A failure not tied to one change. */
  error: string | null;
}

const NO_PREVIEW: Preview = { asked: {}, sql: {}, invalid: {}, error: null };

const signature = (list: ChangeEntry[]) =>
  Object.fromEntries(list.map((c) => [c.id, JSON.stringify(c.change)]));

/**
 * The SQL of `list`, asked PREVIEW_DELAY_MS after the last change; an answer to an older
 * request is ignored.
 */
function useChangesPreview(workspaceId: string, object: ObjectRef, list: ChangeEntry[]): Preview {
  const [preview, setPreview] = useState<Preview>(NO_PREVIEW);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (list.length === 0) return;
    const timer = setTimeout(() => {
      const asked = signature(list);
      ipc
        .changesPreview(
          workspaceId,
          object,
          list.map((c) => c.change),
        )
        .then(
          (sql) => {
            if (mine !== seq.current) return;
            setPreview({
              asked,
              sql: Object.fromEntries(list.map((c, i) => [c.id, sql[i] ?? ""])),
              invalid: {},
              error: null,
            });
          },
          (e) => {
            if (mine !== seq.current) return;
            const err = toAppError(e);
            const refused = refusedChange(err);
            const entry = refused ? list[refused.index] : undefined;
            setPreview(
              refused && entry
                ? { asked, sql: {}, invalid: { [entry.id]: refused.reason }, error: null }
                : { asked, sql: {}, invalid: {}, error: err.message },
            );
          },
        );
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      // Unmounted, or a newer request supersedes this one.
      if (seq.current === mine) seq.current++;
    };
  }, [workspaceId, object, list]);
  return preview;
}

/**
 * The bottom panel of a table tab: one line per pending change (kind, row, columns, its
 * SQL, its apply error) with an Undo each. Hidden while nothing is pending; it opens
 * again with the first change after that, and can be collapsed.
 */
export function PendingChangesPanel({ workspaceId, tabId, object }: Props) {
  const tab = usePendingChanges((st) => st.tabs[tabId]);
  const committing = usePendingChanges((st) => st.committing[tabId] ?? false);
  const edits = tab?.edits;
  const inserts = tab?.inserts;
  const deletes = tab?.deletes;
  // Only a change to the changes themselves (not to their errors) asks for a new preview.
  const list = useMemo(
    () => (edits || inserts || deletes ? usePendingChanges.getState().changeList(tabId) : []),
    [tabId, edits, inserts, deletes],
  );
  const preview = useChangesPreview(workspaceId, object, list);
  const current = useMemo(() => signature(list), [list]);
  // Only what was asked for the changes as they are now (no stale SQL while a new preview runs).
  const fresh = (id: string) => preview.asked[id] === current[id];
  const allFresh =
    list.every((c) => fresh(c.id)) && Object.keys(preview.asked).length === list.length;

  const [open, setOpen] = useState(true);
  const [empty, setEmpty] = useState(list.length === 0);
  if (empty !== (list.length === 0)) {
    setEmpty(list.length === 0);
    if (list.length > 0) setOpen(true);
  }

  if (list.length === 0) return null;
  const errors = tab?.errors ?? {};

  return (
    <section className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-border bg-surface text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-1 text-left font-semibold hover:bg-surface-2"
      >
        <span aria-hidden="true" className="text-muted">
          {open ? strings.grid.panelOpen : strings.grid.panelClosed}
        </span>
        {s.title(list.length)}
      </button>
      {open && (
        <>
          {preview.error && allFresh && (
            <p className="border-t border-border px-3 py-1 text-danger">{s.previewFailed(preview.error)}</p>
          )}
          <ol aria-label={s.label} className="min-h-0 overflow-auto">
            {list.map((c, i) => {
              const { target, columns } = describe(c.change);
              const kind = KIND[c.change.kind];
              const sql = fresh(c.id) ? preview.sql[c.id] : undefined;
              const invalid = fresh(c.id) ? preview.invalid[c.id] : undefined;
              const failed = errors[c.id];
              return (
                <li key={c.id} className="border-t border-border px-3 py-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`rounded-sm px-1 font-mono text-xs font-semibold ${kind.badge}`}>
                      {kind.label}
                    </span>
                    <span className="truncate">{target}</span>
                    {columns && <span className="truncate text-muted">{columns}</span>}
                    <button
                      type="button"
                      className={`${btn} ml-auto shrink-0`}
                      aria-label={s.undoLabel(i + 1)}
                      disabled={committing}
                      onClick={() => usePendingChanges.getState().revertChange(tabId, c.id)}
                    >
                      {s.undo}
                    </button>
                  </div>
                  {sql && (
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs text-muted">{sql}</pre>
                  )}
                  {invalid && <p className="break-words text-danger">{invalid}</p>}
                  {failed && <p className="break-words text-danger">{failed}</p>}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
