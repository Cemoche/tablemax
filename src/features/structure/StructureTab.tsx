import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql } from "@codemirror/lang-sql";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { AppError, Dialect, ForeignKeyInfo, ObjectRef, TableInfo } from "../../lib/types";
import { useResolvedDark } from "../../lib/theme";
import { useSettings } from "../../stores/settings";
import { useWorkspaces } from "../../stores/workspaces";
import { DIALECTS, buildEditorTheme, editorFontStyle, highlight } from "../editor/SqlEditor";

const s = strings.structure;

type Section = "columns" | "indexes" | "foreignKeys" | "ddl";
const SECTIONS: Section[] = ["columns", "indexes", "foreignKeys", "ddl"];

type Loaded<T> = { data: T | null; error: AppError | null };

const th = "border-b border-border px-2 py-1 text-left font-medium text-muted";
const td = "border-b border-border px-2 py-1 align-top";
const badge = "rounded-sm border border-border bg-surface-2 px-1 text-xs text-muted";

const refName = (fk: ForeignKeyInfo) => (fk.refSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable);

function Empty({ text }: { text: string }) {
  return <p className="p-3 text-muted">{text}</p>;
}

function ColumnsTable({ info }: { info: TableInfo }) {
  if (info.columns.length === 0) return <Empty text={s.noColumns} />;
  const pk = new Set(info.primaryKey);
  const fk = new Set(info.foreignKeys.flatMap((f) => f.columns));
  return (
    <table aria-label={s.tabs.columns} className="w-full border-collapse">
      <thead>
        <tr>
          {(["name", "type", "nullable", "default", "extra", "comment"] as const).map((k) => (
            <th key={k} scope="col" className={th}>
              {s.columnHeaders[k]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {info.columns.map((c) => (
          <tr key={c.name}>
            <td className={td}>
              <span className="flex items-center gap-1">
                {c.name}
                {pk.has(c.name) && (
                  <span role="img" aria-label={s.primaryKeyLabel} className={badge}>
                    {s.primaryKey}
                  </span>
                )}
                {fk.has(c.name) && (
                  <span role="img" aria-label={s.foreignKeyLabel} className={badge}>
                    {s.foreignKey}
                  </span>
                )}
              </span>
            </td>
            <td className={`${td} font-mono`}>{c.typeName}</td>
            <td className={td}>{c.nullable ? s.yes : s.no}</td>
            <td className={`${td} font-mono`}>{c.default ?? ""}</td>
            <td className={td}>
              <span className="flex gap-1">
                {c.autoIncrement && <span className={badge}>{s.autoIncrement}</span>}
                {c.generated && <span className={badge}>{s.generated}</span>}
              </span>
            </td>
            <td className={td}>{c.comment ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IndexesTable({ info }: { info: TableInfo }) {
  if (info.indexes.length === 0) return <Empty text={s.noIndexes} />;
  return (
    <table aria-label={s.tabs.indexes} className="w-full border-collapse">
      <thead>
        <tr>
          {(["name", "columns", "kind", "definition"] as const).map((k) => (
            <th key={k} scope="col" className={th}>
              {s.indexHeaders[k]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {info.indexes.map((i, n) => (
          <tr key={`${i.name}#${n}`}>
            <td className={td}>{i.name}</td>
            <td className={td}>{i.columns.join(", ")}</td>
            <td className={td}>
              <span className="flex gap-1">
                {i.primary && <span className={badge}>{s.primary}</span>}
                {i.unique && <span className={badge}>{s.unique}</span>}
              </span>
            </td>
            <td className={`${td} font-mono`}>{i.definition ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ForeignKeysTable({ info, workspaceId }: { info: TableInfo; workspaceId: string }) {
  const openTableTab = useWorkspaces((st) => st.openTableTab);
  if (info.foreignKeys.length === 0) return <Empty text={s.noForeignKeys} />;
  return (
    <table aria-label={s.tabs.foreignKeys} className="w-full border-collapse">
      <thead>
        <tr>
          {(["name", "columns", "references", "onUpdate", "onDelete"] as const).map((k) => (
            <th key={k} scope="col" className={th}>
              {s.fkHeaders[k]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {info.foreignKeys.map((fk, n) => {
          const target: ObjectRef = { schema: fk.refSchema, name: fk.refTable };
          return (
            <tr key={`${fk.name}#${n}`}>
              <td className={td}>{fk.name}</td>
              <td className={td}>{fk.columns.join(", ")}</td>
              <td className={td}>
                <button
                  type="button"
                  aria-label={s.openReferenced(refName(fk))}
                  onClick={() => openTableTab(workspaceId, target)}
                  className="text-accent underline"
                >
                  {refName(fk)}
                </button>
                {` (${fk.refColumns.join(", ")})`}
              </td>
              <td className={td}>{fk.onUpdate}</td>
              <td className={td}>{fk.onDelete}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DdlView({ ddl, dialect }: { ddl: string; dialect: Dialect }) {
  const dark = useResolvedDark();
  const fontFamily = useSettings((s) => s.settings.editorFontFamily);
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => setCopyState("idle"), [ddl]);
  const extensions = useMemo(
    () => [
      sql({ dialect: DIALECTS[dialect] }),
      buildEditorTheme(dark),
      highlight,
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ],
    [dialect, dark],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ddl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <button type="button" onClick={copy} className="rounded-sm border border-border px-2 py-1">
          {s.copy}
        </button>
        <span role="status" className="text-muted">
          {copyState === "copied" ? s.copied : copyState === "failed" ? s.copyFailed : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <CodeMirror
          value={ddl}
          height="100%"
          style={editorFontStyle(fontFamily, fontSize)}
          aria-label={s.ddlLabel}
          theme="none"
          extensions={extensions}
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
        />
      </div>
    </div>
  );
}

/** Read-only structure of a table: columns, indexes, foreign keys and DDL. */
export function StructureTab({
  workspaceId,
  object,
  dialect,
}: {
  workspaceId: string;
  object: ObjectRef;
  dialect: Dialect;
}) {
  const [section, setSection] = useState<Section>("columns");
  const [info, setInfo] = useState<Loaded<TableInfo>>({ data: null, error: null });
  const [ddl, setDdl] = useState<Loaded<string>>({ data: null, error: null });
  const [pending, setPending] = useState(true);
  const run = useRef(0);
  const uid = useId();
  const tabId = (k: Section) => `${uid}-tab-${k}`;
  const panelId = `${uid}-panel`;

  const load = useCallback(
    (refresh: boolean) => {
      const id = ++run.current;
      setPending(true);
      const live = () => id === run.current;
      const infoP = ipc.tableInfo(workspaceId, object, refresh).then(
        (data) => live() && setInfo({ data, error: null }),
        (e) => live() && setInfo({ data: null, error: toAppError(e) }),
      );
      const ddlP = ipc.tableDdl(workspaceId, object).then(
        (data) => live() && setDdl({ data, error: null }),
        (e) => live() && setDdl({ data: null, error: toAppError(e) }),
      );
      void Promise.all([infoP, ddlP]).then(() => live() && setPending(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, object.schema, object.name],
  );

  useEffect(() => {
    setInfo({ data: null, error: null });
    setDdl({ data: null, error: null });
    load(false);
    return () => {
      run.current++;
    };
  }, [load]);

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = SECTIONS[(i + d + SECTIONS.length) % SECTIONS.length];
    setSection(next);
    document.getElementById(tabId(next))?.focus();
  };

  const infoLoading = !info.data && !info.error;
  const panel = () => {
    if (section === "ddl") {
      if (ddl.error) return <p role="alert" className="p-3 text-danger">{s.ddlFailed(ddl.error.message)}</p>;
      if (ddl.data === null) return <Empty text={s.ddlLoading} />;
      return <DdlView ddl={ddl.data} dialect={dialect} />;
    }
    if (info.error) return <p role="alert" className="p-3 text-danger">{s.loadFailed(info.error.message)}</p>;
    if (!info.data) return null;
    if (section === "columns") return <ColumnsTable info={info.data} />;
    if (section === "indexes") return <IndexesTable info={info.data} />;
    return <ForeignKeysTable info={info.data} workspaceId={workspaceId} />;
  };

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="flex items-center justify-between border-b border-border px-2">
        <div role="tablist" aria-label={s.tabsLabel} className="flex">
          {SECTIONS.map((k, i) => (
            <button
              key={k}
              id={tabId(k)}
              type="button"
              role="tab"
              aria-selected={section === k}
              aria-controls={panelId}
              tabIndex={section === k ? 0 : -1}
              onClick={() => setSection(k)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`border-b-2 px-3 py-2 ${
                section === k ? "border-accent text-fg" : "border-transparent text-muted"
              }`}
            >
              {s.tabs[k]}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={pending}
          aria-busy={pending}
          onClick={() => load(true)}
          className="rounded-sm border border-border px-2 py-1 disabled:opacity-50"
        >
          {s.refresh}
        </button>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(section)}
        className="min-h-0 flex-1 overflow-auto"
      >
        {infoLoading && section !== "ddl" ? <Empty text={s.loading} /> : panel()}
      </div>
    </div>
  );
}
