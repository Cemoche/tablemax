import { useEffect, useId, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import type { CellValue, EditValue, ObjectRef, ResultSet, TableInfo } from "../../lib/types";
import { type EditCell, type GridModel, type MenuAction, menuActions } from "./editModel";
import { cellText, readOnlyReason } from "./editing";
import type { FkLink } from "./fkLinks";
import { prettyJson } from "./prettyJson";

interface Props {
  workspaceId: string;
  object: ObjectRef;
  /** The loaded page the model is built on. */
  data: ResultSet;
  info: TableInfo | null;
  model: GridModel;
  /** Display row of `model`, null when no row is selected. */
  row: number | null;
  onChange: (row: number, col: number, value: EditValue) => void;
  /** A cell action of the grid's menu (Set NULL, Set empty string, Set DEFAULT, Revert cell). */
  onAction: (action: MenuAction, row: number, col: number) => void;
  /** The foreign key links of a cell (each field offers to open them). */
  linksAt: (row: number, col: number) => FkLink[];
  onOpenLink: (link: FkLink) => void;
  onClose: () => void;
}

/** The menu actions a field offers (the row actions stay in the grid's menu). */
const FIELD_ACTIONS: readonly MenuAction[] = ["setNull", "setEmpty", "setDefault", "revertCell"];

type Full = { s: "loading" } | { s: "ready"; value: CellValue } | { s: "failed"; message: string };

/**
 * The whole values of the long-text cells of a loaded row (cell_value), per
 * `<rowKeyId>\0<column>`; forgotten when the page is reloaded. A failed load is tried
 * again by `retry` (or when the row is selected again).
 */
function useFullValues(
  workspaceId: string,
  object: ObjectRef,
  data: ResultSet,
  model: GridModel,
  row: number | null,
): { values: Record<string, Full>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ data: ResultSet; values: Record<string, Full> }>({
    data,
    values: {},
  });
  const started = useRef<{ data: ResultSet; ids: Set<string> }>({ data, ids: new Set() });
  const r = row === null ? undefined : model.rows[row];
  const loaded = r?.kind === "row" ? r : null;
  const keyId = loaded?.keyId ?? null;
  const index = loaded?.index ?? -1;
  const key = loaded?.key ?? null;

  useEffect(() => {
    if (!key || keyId === null) return;
    if (started.current.data !== data) started.current = { data, ids: new Set() };
    const put = (id: string, full: Full) =>
      setState((prev) => {
        if (started.current.data !== data) return prev; // the page was reloaded since
        const values = prev.data === data ? prev.values : {};
        return { data, values: { ...values, [id]: full } };
      });
    data.columns.forEach((c, i) => {
      if (data.rows[index]?.[i]?.t !== "longText") return;
      const id = `${keyId}\u0000${c.name}`;
      if (started.current.ids.has(id)) return;
      started.current.ids.add(id);
      put(id, { s: "loading" });
      ipc.cellValue(workspaceId, object, key, c.name).then(
        (value) => put(id, { s: "ready", value }),
        (e) => {
          if (started.current.data === data) started.current.ids.delete(id);
          put(id, { s: "failed", message: toAppError(e).message });
        },
      );
    });
    // `key` is identified by keyId.
  }, [workspaceId, object, data, keyId, index, attempt]);

  return {
    values: state.data === data ? state.values : {},
    retry: () => setAttempt((n) => n + 1),
  };
}

/** What a field shows for `value`: JSON indented, NULL as an empty field with a placeholder. */
function shown(value: CellValue | "default", full: Full | undefined): { text: string; placeholder?: string } {
  if (value === "default") return { text: "", placeholder: strings.grid.defaultText };
  if (value.t === "null") return { text: "", placeholder: strings.grid.nullText };
  if (value.t === "json") return { text: prettyJson(value.v) };
  if (value.t === "longText") {
    if (full?.s === "ready") return shown(full.value, undefined);
    return { text: `${value.v.preview}…` };
  }
  return { text: cellText(value) };
}

/**
 * The right panel of a table tab: the selected row as a vertical form (column, type,
 * value). Long text and cut JSON are loaded in full; editable fields follow the grid's
 * rules and go through the same store actions.
 */
export function RowDetailPanel(p: Props) {
  const full = useFullValues(p.workspaceId, p.object, p.data, p.model, p.row);
  // Fields are keyed by record and page: a reload starts them afresh (no draft carried over).
  const [page, setPage] = useState({ data: p.data, n: 0 });
  if (page.data !== p.data) setPage({ data: p.data, n: page.n + 1 });
  const r = p.row === null ? undefined : p.model.rows[p.row];
  const tableEditable = p.info !== null && readOnlyReason(p.info) === null;
  const keyIssue = r?.kind === "row" ? r.keyIssue : null;

  return (
    <aside
      aria-label={strings.grid.rowDetails}
      className="flex w-80 shrink-0 flex-col border-l border-border bg-bg text-sm"
    >
      <div className="flex items-center border-b border-border bg-surface px-3 py-1">
        <h2 className="font-semibold">{strings.grid.rowDetails}</h2>
        <button
          type="button"
          aria-label={strings.grid.rowDetailsClose}
          onClick={p.onClose}
          className="ml-auto rounded-sm px-1.5 hover:bg-surface-2"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {p.row === null || !r ? (
          <p className="text-muted">{strings.grid.rowDetailsEmpty}</p>
        ) : (
          <>
            {keyIssue && <p className="mb-2 text-muted">{keyIssue}</p>}
            {p.model.columns.map((name, col) => {
              const rowKeyId = r.kind === "row" ? r.keyId : null;
              const id =
                r.kind === "insert"
                  ? `insert:${r.tempId}`
                  : rowKeyId !== null
                    ? `key:${rowKeyId}`
                    : `index:${r.index}`;
              return (
                <Field
                  key={`${page.n}\u0000${id}\u0000${name}`}
                  name={name}
                  type={p.info?.columns.find((c) => c.name === name)?.typeName ?? p.data.columns[col]?.typeName ?? ""}
                  cell={p.model.cell(p.row!, col)}
                  full={rowKeyId === null ? undefined : full.values[`${rowKeyId}\u0000${name}`]}
                  onRetry={full.retry}
                  actions={menuActions(p.model, p.row!, col).filter((a) => FIELD_ACTIONS.includes(a))}
                  showReason={tableEditable && !keyIssue}
                  links={p.linksAt(p.row!, col)}
                  onOpenLink={p.onOpenLink}
                  onChange={(v) => p.onChange(p.row!, col, v)}
                  onAction={(a) => p.onAction(a, p.row!, col)}
                />
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}

interface FieldProps {
  name: string;
  type: string;
  cell: EditCell;
  full: Full | undefined;
  actions: MenuAction[];
  /** Say why this column is read-only (not when the whole table or row is). */
  showReason: boolean;
  links: FkLink[];
  onOpenLink: (link: FkLink) => void;
  onChange: (value: EditValue) => void;
  onAction: (action: MenuAction) => void;
  onRetry: () => void;
}

/** The pending value a field shows, as written back. */
const editValueOf = (v: CellValue | "default"): EditValue =>
  v === "default" ? { t: "default" } : v.t === "null" ? { t: "null" } : { t: "text", v: cellText(v) };

function Field({
  name,
  type,
  cell,
  full,
  actions,
  showReason,
  links,
  onOpenLink,
  onChange,
  onAction,
  onRetry,
}: FieldProps) {
  const id = useId();
  /** What the user typed, while the field has the focus (the store has it too). */
  const [draft, setDraft] = useState<string | null>(null);
  /** What the field held before this round of typing: typing that text back restores it. */
  const start = useRef<{ text: string; value: EditValue | null } | null>(null);
  const view = shown(cell.value, full);
  const waiting = cell.truncated && full?.s !== "ready";
  const editable = cell.editable && !waiting;
  const noValue = cell.value === "default" || cell.value.t === "null";
  // Set NULL when the field holds a value, Set empty string when it holds none.
  const offered = actions.filter((a) =>
    a === "setNull" ? cell.value === "default" || cell.value.t !== "null" : a === "setEmpty" ? noValue : true,
  );

  const change = (text: string) => {
    start.current ??= { text: draft ?? view.text, value: cell.edited ? editValueOf(cell.value) : null };
    const from = start.current;
    setDraft(text);
    if (from && text === from.text) {
      // Back to the start: the loaded value (revert, so JSON is never rewritten) or the
      // pending value it had (e.g. an empty string set on a NULL column stays '').
      if (from.value) onChange(from.value);
      else onAction("revertCell");
    } else onChange({ t: "text", v: text });
  };

  const text = draft ?? view.text;
  return (
    <div className="mb-3">
      <div className="flex items-baseline gap-2">
        <label htmlFor={id} className="font-semibold break-all">
          {name}
        </label>
        <span className="truncate text-xs text-muted">{type}</span>
        {cell.edited && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warning" />}
        {links.length > 0 && (
          <span className="ml-auto flex min-w-0 shrink-0 gap-1">
            {links.map((l, i) => (
              <button
                key={`${i}\u0000${l.fk.name}`}
                type="button"
                aria-label={strings.grid.openReferencedIn(l.object.name)}
                {...tip(strings.grid.openReferencedIn(l.object.name))}
                onClick={() => onOpenLink(l)}
                className="max-w-40 truncate rounded-sm px-1 text-xs text-accent hover:bg-surface-2"
              >
                {strings.grid.fkLinkButton(l.object.name)}
              </button>
            ))}
          </span>
        )}
      </div>
      <textarea
        id={id}
        value={text}
        placeholder={view.placeholder}
        readOnly={!editable}
        rows={Math.min(12, Math.max(1, text.split("\n").length))}
        spellCheck={false}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          setDraft(null);
          start.current = null;
        }}
        className={`mt-1 block w-full resize-y rounded-sm border border-border px-2 py-1 font-mono outline-none focus:border-accent ${
          cell.edited ? "bg-pending-edit" : "bg-surface"
        } ${editable ? "text-fg" : "text-muted"}`}
      />
      {full?.s === "loading" && <p className="text-xs text-muted">{strings.grid.editorLoading}</p>}
      {full?.s === "failed" && (
        <p className="flex items-baseline gap-2 text-xs text-danger">
          <span className="min-w-0 break-words">{strings.grid.editorLoadFailed(full.message)}</span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-sm border border-border px-1.5 text-fg hover:bg-surface-2"
          >
            {strings.grid.retry}
          </button>
        </p>
      )}
      {showReason && cell.reason && <p className="text-xs text-muted">{cell.reason}</p>}
      {offered.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {offered.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => {
                setDraft(null);
                onAction(a);
              }}
              className="rounded-sm border border-border px-1.5 text-xs hover:bg-surface-2"
            >
              {strings.grid.menu[a]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
