import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { registerPendingFlush } from "../../lib/pendingFlush";
import { toAppError } from "../../lib/errors";
import { useShortcut } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { useAutoLimit } from "../../stores/autoLimit";
import { useCatalog } from "../../stores/catalog";
import { useQueryPanels } from "../../stores/queryPanels";
import { useQueryRuns } from "../../stores/queryRuns";
import { useSavedQueries } from "../../stores/savedQueries";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { applyAutoLimit } from "./autoLimit";
import { buildCompletionSource } from "./completion";
import { ConfirmDialog, NameDialog } from "./Dialogs";
import { HistoryPanel } from "./HistoryPanel";
import { ResultsPanel } from "./ResultsPanel";
import { SavedQueries } from "./SavedQueries";
import { type EditorSelection, type RunMode, SqlEditor, insertAtCursor, replaceDocument } from "./SqlEditor";
import { type Statement, delimiterAt, splitStatements, statementAt } from "./splitStatements";

const SAVE_DEBOUNCE_MS = 300;
/** Row cap added by "Auto LIMIT" (Plan 5 makes it a setting). */
export const AUTO_LIMIT_ROWS = 1000;

const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

/** History refresh after a run: the backend records the batch just after it ends. */
const HISTORY_SETTLE_MS = 500;

type QueryTabT = Extract<Tab, { kind: "query" }>;

/** The tab as it is in the store now (props may lag behind an action). */
function currentTab(wsId: string, tabId: string): QueryTabT | null {
  const t = useWorkspaces
    .getState()
    .workspaces.find((w) => w.id === wsId)
    ?.tabs.find((x) => x.id === tabId);
  return t?.kind === "query" ? t : null;
}

/** Read from the store (not props) so a just-opened session is seen immediately. */
function currentSessionId(wsId: string, tabId: string): string | null {
  const t = useWorkspaces
    .getState()
    .workspaces.find((w) => w.id === wsId)
    ?.tabs.find((x) => x.id === tabId);
  return t?.kind === "query" ? t.sqlSessionId : null;
}

function tabExists(wsId: string, tabId: string): boolean {
  return !!useWorkspaces
    .getState()
    .workspaces.find((w) => w.id === wsId)
    ?.tabs.some((t) => t.id === tabId);
}

interface Props {
  workspace: Workspace;
  tab: Extract<Tab, { kind: "query" }>;
}

export function QueryTab({ workspace, tab }: Props) {
  const wsId = workspace.id;
  const tabId = tab.id;
  const dialect = workspace.dialect;
  const [text, setText] = useState(tab.sql);
  const textRef = useRef(tab.sql);
  const selRef = useRef<EditorSelection>({ from: 0, to: 0, head: 0 });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useQueryRuns((s) => s.runs[tabId]);
  const running = run?.running ?? false;
  const autoLimit = useAutoLimit((s) => !!s.on[tabId]);
  const [notice, setNotice] = useState<string | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const connectionId = workspace.connectionId;
  const historyOpen = useQueryPanels((s) => !!s.history[tabId]);
  const savedOpen = useQueryPanels((s) => s.savedOpen);
  // Name dialog of a first save (error: the backend's refusal); replace confirmation.
  const [saveDialog, setSaveDialog] = useState<{ error: string | null } | null>(null);
  const [replaceName, setReplaceName] = useState<string | null>(null);
  const linkedName = tab.savedName ?? null;
  const modified = !!linkedName && typeof tab.savedSql === "string" && tab.savedSql !== text;

  // The history panel reloads when a run ends (and once more when the backend's write
  // of the batch has surely landed).
  const [historyKey, setHistoryKey] = useState(0);
  const wasRunning = useRef(running);
  useEffect(() => {
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (!ended) return;
    setHistoryKey((k) => k + 1);
    const t = setTimeout(() => setHistoryKey((k) => k + 1), HISTORY_SETTLE_MS);
    return () => clearTimeout(t);
  }, [running]);

  // Completion catalog of the current schema (loaded once per schema by the store); other
  // schemas already in the store are offered as `schema.table`.
  const { status, currentSchema: schema, database, schemas } = workspace;
  useEffect(() => {
    if (status === "connected") void useCatalog.getState().ensureCatalog(wsId, schema);
  }, [wsId, schema, status, database]);
  const wsCatalogs = useCatalog((s) => s.catalogs[wsId]);
  const completionSource = useMemo(() => {
    const key = schema ?? "";
    const others = Object.entries(wsCatalogs ?? {})
      .filter(([k]) => k !== key)
      .map(([, e]) => e.catalog);
    return buildCompletionSource(wsCatalogs?.[key]?.catalog ?? null, dialect, {
      otherCatalogs: others,
      schemas,
      loadSchema: (s) =>
        status === "connected" ? useCatalog.getState().ensureCatalog(wsId, s) : Promise.resolve(null),
    });
  }, [wsCatalogs, schema, schemas, dialect, status, wsId]);

  const flush = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    useWorkspaces.getState().updateTab(wsId, tabId, { sql: textRef.current });
  }, [wsId, tabId]);

  // Persist pending text when the tab unmounts (tab switch / close).
  useEffect(
    () => () => {
      if (saveTimer.current) flush();
    },
    [flush],
  );

  // The window close pushes the debounced text into the store before saving the session.
  useEffect(
    () =>
      registerPendingFlush(() => {
        if (saveTimer.current) flush();
      }),
    [flush],
  );

  const onChange = (v: string) => {
    if (notice) setNotice(null);
    textRef.current = v;
    setText(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  /** A lost SQL session is unusable: close it and forget it so the next Run reconnects. */
  const dropLostSession = (sid: string) => {
    void ipc.sqlSessionClose(sid)?.catch(() => {});
    if (currentSessionId(wsId, tabId) === sid) {
      useWorkspaces.getState().updateTab(wsId, tabId, { sqlSessionId: null });
    }
  };

  const execute = async (stmts: Statement[]) => {
    const runs = useQueryRuns.getState();
    if (stmts.length === 0 || runs.runs[tabId]?.running) return;
    flush();
    runs.start(tabId, stmts.length);
    let sessionId = currentSessionId(wsId, tabId);
    try {
      if (!sessionId) {
        // PostgreSQL: the tab stays on the database of its first session, even after the
        // workspace switched database (a lost session reopens there).
        const current = useWorkspaces.getState().workspaces.find((w) => w.id === wsId)?.database ?? null;
        const database = dialect === "postgres" ? (currentTab(wsId, tabId)?.database ?? current) : null;
        const opened = await ipc.sqlSessionOpen(wsId, database);
        if (!tabExists(wsId, tabId)) {
          // Tab closed while the session was opening: nothing owns it any more.
          void ipc.sqlSessionClose(opened)?.catch(() => {});
          useQueryRuns.getState().drop(tabId);
          return;
        }
        sessionId = opened;
        useWorkspaces.getState().updateTab(wsId, tabId, {
          sqlSessionId: sessionId,
          ...(database !== null && { database }),
        });
      }
      const sid = sessionId;
      const limited = useAutoLimit.getState().on[tabId];
      await ipc.sqlExecute(
        sid,
        stmts.map((s) => (limited ? applyAutoLimit(s.text, dialect, AUTO_LIMIT_ROWS) : s.text)),
        (e) => {
          useQueryRuns.getState().applyEvent(tabId, e);
          if (e.event === "statementFailed" && e.data.error.kind === "connectionLost") {
            dropLostSession(sid);
          }
        },
      );
    } catch (e) {
      const err = toAppError(e);
      useQueryRuns.getState().preflightFailed(tabId, err);
      if (err.kind === "connectionLost" && sessionId) dropLostSession(sessionId);
    }
  };

  const runMode = (mode: RunMode) => {
    const all = splitStatements(textRef.current, dialect);
    if (mode === "all") return void execute(all);
    const { from, to, head } = selRef.current;
    if (from !== to) {
      // A selection inside a `DELIMITER //` region splits with that delimiter.
      const delimiter = delimiterAt(textRef.current, from, dialect);
      return void execute(splitStatements(textRef.current.slice(from, to), dialect, { delimiter }));
    }
    const one = statementAt(all, head);
    void execute(one ? [one] : []);
  };
  const runModeRef = useRef(runMode);
  runModeRef.current = runMode;

  // ---- History: insert / replace in the editor (one undo step each). ----
  const insertSql = (sql: string) => {
    const view = viewRef.current;
    if (view) return insertAtCursor(view, sql);
    const { from, to } = selRef.current;
    const cur = textRef.current;
    onChange(cur.slice(0, from) + sql + cur.slice(to));
  };
  const replaceSql = (sql: string) => {
    const view = viewRef.current;
    if (view) return replaceDocument(view, sql);
    onChange(sql);
  };

  // ---- Saved queries: Mod+S saves (asks for a name the first time). ----
  const saveAs = async (name: string, confirmed = false) => {
    if (!confirmed) {
      let list = useSavedQueries.getState().lists[connectionId];
      if (!list) {
        try {
          await useSavedQueries.getState().load(connectionId);
          list = useSavedQueries.getState().lists[connectionId];
        } catch {
          // Unknown: the write below reports real problems.
        }
      }
      // Case-insensitive: on some file systems `Report` and `report` are one file. The
      // replacement keeps the existing spelling, so it is the same file everywhere (and
      // the name the confirmation shows).
      const existing = list?.find((q) => q.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        setReplaceName(existing.name);
        return;
      }
    }
    try {
      flush();
      await useSavedQueries.getState().saveTab(wsId, tabId, name, textRef.current);
      setReplaceName(null);
      setSaveDialog(null);
    } catch (e) {
      setReplaceName(null);
      setSaveDialog({ error: toAppError(e).message });
    }
  };

  const save = async () => {
    flush();
    const name = currentTab(wsId, tabId)?.savedName;
    if (!name) {
      setSaveDialog({ error: null });
      return;
    }
    try {
      await useSavedQueries.getState().saveTab(wsId, tabId, name, textRef.current);
    } catch (e) {
      setNotice(strings.savedQueries.saveFailed(toAppError(e).message));
    }
  };

  // Mounted only for the active SQL tab: in a table tab Mod+S stays the grid's commit.
  useShortcut("Mod+S", () => void save());
  useShortcut("Mod+Shift+H", () => useQueryPanels.getState().toggleHistory(tabId));

  const cancel = () => {
    const sid = currentSessionId(wsId, tabId);
    if (sid) void ipc.sqlCancel(sid)?.catch(() => {});
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1">
        <button
          type="button"
          className={btn}
          aria-pressed={savedOpen}
          onClick={() => useQueryPanels.getState().toggleSaved()}
        >
          {strings.savedQueries.toggle}
        </button>
        <button type="button" className={btn} onClick={() => runMode("current")} disabled={running}>
          {strings.query.run}
        </button>
        <button type="button" className={btn} onClick={() => runMode("all")} disabled={running}>
          {strings.query.runAll}
        </button>
        {running && (
          <button type="button" className={`${btn} text-danger`} onClick={cancel}>
            {strings.query.cancel}
          </button>
        )}
        {notice && (
          <span role="status" className="truncate text-sm text-warning">
            {notice}
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-1 text-sm">
          {linkedName && (
            <span className="truncate text-muted" title={strings.savedQueries.linked(linkedName)}>
              {linkedName}
            </span>
          )}
          {modified && (
            <span
              role="img"
              aria-label={strings.savedQueries.modified}
              title={strings.savedQueries.modified}
              className="text-warning"
            >
              {strings.savedQueries.modifiedDot}
            </span>
          )}
        </span>
        <button
          type="button"
          className={btn}
          title={strings.savedQueries.saveHint}
          onClick={() => void save()}
        >
          {strings.savedQueries.save}
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={historyOpen}
          title={strings.history.toggleHint}
          onClick={() => useQueryPanels.getState().toggleHistory(tabId)}
        >
          {strings.history.toggle}
        </button>
        <label
          className="flex shrink-0 items-center gap-1 text-sm"
          title={strings.query.autoLimitHint(AUTO_LIMIT_ROWS)}
        >
          <input
            type="checkbox"
            checked={autoLimit}
            onChange={(e) => useAutoLimit.getState().setAutoLimit(tabId, e.target.checked)}
          />
          {strings.query.autoLimit(AUTO_LIMIT_ROWS)}
        </label>
      </div>
      <div className="flex min-h-0 flex-1">
        {savedOpen && <SavedQueries workspace={workspace} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 basis-1/2">
            <SqlEditor
              onView={(v) => {
                viewRef.current = v;
              }}
              tabId={tab.id}
              value={text}
              onChange={onChange}
              dialect={dialect}
              onRun={(m) => runModeRef.current(m)}
              completionSource={completionSource}
              onNotice={setNotice}
              onSelectionChange={(s) => {
                selRef.current = s;
              }}
            />
          </div>
          <div className="min-h-0 flex-1 basis-1/2 border-t border-border">
            <ResultsPanel run={run} />
          </div>
        </div>
        {historyOpen && (
          <HistoryPanel
            connectionId={connectionId}
            connectionName={workspace.name}
            refreshKey={historyKey}
            onInsert={insertSql}
            onReplace={replaceSql}
            onClose={() => useQueryPanels.getState().setHistory(tabId, false)}
          />
        )}
      </div>
      {saveDialog && (
        <NameDialog
          title={strings.savedQueries.saveTitle}
          label={strings.savedQueries.nameLabel}
          initial=""
          confirm={strings.savedQueries.saveConfirm}
          cancel={strings.savedQueries.cancel}
          error={saveDialog.error}
          onSubmit={(name) => void saveAs(name)}
          onCancel={() => setSaveDialog(null)}
        />
      )}
      {replaceName !== null && (
        <ConfirmDialog
          title={strings.savedQueries.replaceTitle}
          body={strings.savedQueries.replaceBody(replaceName)}
          confirm={strings.savedQueries.replaceConfirm}
          cancel={strings.savedQueries.cancel}
          onConfirm={() => void saveAs(replaceName, true)}
          onCancel={() => setReplaceName(null)}
        />
      )}
    </div>
  );
}
