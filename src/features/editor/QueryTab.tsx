import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { toAppError } from "../../lib/errors";
import { strings } from "../../lib/strings";
import { useQueryRuns } from "../../stores/queryRuns";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { ResultsPanel } from "./ResultsPanel";
import { type EditorSelection, type RunMode, SqlEditor } from "./SqlEditor";
import { type Statement, splitStatements, statementAt } from "./splitStatements";

const SAVE_DEBOUNCE_MS = 300;

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
    textRef.current = v;
    setText(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  const execute = async (stmts: Statement[]) => {
    const runs = useQueryRuns.getState();
    if (stmts.length === 0 || runs.runs[tabId]?.running) return;
    flush();
    runs.start(tabId, stmts.length);
    try {
      let sessionId = currentSessionId(wsId, tabId);
      if (!sessionId) {
        sessionId = await ipc.sqlSessionOpen(wsId);
        useWorkspaces.getState().updateTab(wsId, tabId, { sqlSessionId: sessionId });
      }
      await ipc.sqlExecute(
        sessionId,
        stmts.map((s) => s.text),
        (e) => useQueryRuns.getState().applyEvent(tabId, e),
      );
    } catch (e) {
      useQueryRuns.getState().preflightFailed(tabId, toAppError(e));
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
      </div>
      <div className="min-h-0 flex-1 basis-1/2">
        <SqlEditor
          value={text}
          onChange={onChange}
          dialect={dialect}
          onRun={(m) => runModeRef.current(m)}
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
