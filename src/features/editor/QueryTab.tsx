import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { toAppError } from "../../lib/errors";
import { strings } from "../../lib/strings";
import { useAutoLimit } from "../../stores/autoLimit";
import { useCatalog } from "../../stores/catalog";
import { useQueryRuns } from "../../stores/queryRuns";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { applyAutoLimit } from "./autoLimit";
import { buildCompletionSource } from "./completion";
import { ResultsPanel } from "./ResultsPanel";
import { type EditorSelection, type RunMode, SqlEditor } from "./SqlEditor";
import { type Statement, splitStatements, statementAt } from "./splitStatements";

const SAVE_DEBOUNCE_MS = 300;
/** Row cap added by "Auto LIMIT" (Plan 5 makes it a setting). */
export const AUTO_LIMIT_ROWS = 1000;

const btn =
  "rounded-sm border border-border px-2 py-0.5 text-sm hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent";

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
        const opened = await ipc.sqlSessionOpen(wsId);
        if (!tabExists(wsId, tabId)) {
          // Tab closed while the session was opening: nothing owns it any more.
          void ipc.sqlSessionClose(opened)?.catch(() => {});
          useQueryRuns.getState().drop(tabId);
          return;
        }
        sessionId = opened;
        useWorkspaces.getState().updateTab(wsId, tabId, { sqlSessionId: sessionId });
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
      return void execute(splitStatements(textRef.current.slice(from, to), dialect));
    }
    const one = statementAt(all, head);
    void execute(one ? [one] : []);
  };
  const runModeRef = useRef(runMode);
  runModeRef.current = runMode;

  const cancel = () => {
    const sid = currentSessionId(wsId, tabId);
    if (sid) void ipc.sqlCancel(sid)?.catch(() => {});
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1">
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
        <label
          className="ml-auto flex shrink-0 items-center gap-1 text-sm"
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
      <div className="min-h-0 flex-1 basis-1/2">
        <SqlEditor
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
  );
}
