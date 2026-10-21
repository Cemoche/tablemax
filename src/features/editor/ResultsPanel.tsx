import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import type { ResultSet } from "../../lib/types";
import type { QueryRun } from "../../stores/queryRuns";
import { DataGrid } from "../grid/DataGrid";

type View = "data" | "message";

const tabClass = (selected: boolean) =>
  `flex h-6 items-center rounded-md px-2.5 text-sm outline-none focus-visible:focus-ring ${
    selected ? "bg-seg-sel text-text" : "text-text-2 hover:bg-seg-sel"
  }`;

/**
 * ← / → (Home / End) between the tabs of a tab list, choosing as they go (automatic
 * activation): one Tab stop for the list, the selected tab.
 */
function onTabListKey(e: KeyboardEvent<HTMLElement>) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const next =
    e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? -1 : null;
  if (next === null) return;
  e.preventDefault();
  const tab = tabs[(next + tabs.length) % tabs.length];
  tab.focus();
  tab.click();
}

/** What the row details panel of a SQL tab shows: the result set on screen and its selected row. */
export interface ShownRow {
  data: ResultSet;
  /** Row of `data` (the grid's active cell row), null when none is selected. */
  row: number | null;
}

interface Props {
  run: QueryRun | undefined;
  /**
   * The result set shown in the grid and its selected row, each time either changes; null
   * when no grid is shown (no run, the Message view, a run without rows yet) (#115).
   */
  onShownRow?: (shown: ShownRow | null) => void;
  /** Space / grid.rowDetails in the results grid. */
  onToggleDetails?: () => void;
  /** Each new value puts the focus in the results grid (Escape in the row details). */
  focusRequest?: number;
}

/**
 * The results of a SQL tab: Data (the result sets in the grid, one tab per set when there
 * are several) and Message (what each statement did, the error, a cancel). A run shows
 * Data when it returned rows and nothing went wrong, else Message (statements without
 * rows, an error or a cancel are only seen there); a tab chosen by hand stays until the
 * next run.
 */
export function ResultsPanel({ run, onShownRow, onToggleDetails, focusRequest }: Props) {
  // Both choices hold for the run they were made in only.
  const [selected, setSelected] = useState<{ run: number; index: number } | null>(null);
  const [chosen, setChosen] = useState<{ run: number; view: View } | null>(null);
  /** The row selected in the grid, for the result set it was selected in. */
  const [pick, setPick] = useState<ShownRow | null>(null);
  const runShortcut = useEffectiveShortcut("editor.run");
  const uid = useId();

  const sets = run ? run.results.filter((r) => r.outcome.result) : [];
  const active = sets.find((r) => run && selected?.run === run.id && r.index === selected.index) ?? sets[0];
  const result = active?.outcome.result ?? null;
  const preferred: View = sets.length > 0 && !run?.error && !run?.cancelled ? "data" : "message";
  const view = run && chosen?.run === run.id ? chosen.view : preferred;
  const shownData = run && view === "data" ? result : null;
  // The grid starts each result set with no selection, and so does a grid shown again (after
  // the Message view): a row picked before is forgotten as soon as another set is on screen.
  if (pick !== null && pick.data !== shownData) setPick(null);
  const shownRow = pick && pick.data === shownData ? pick.row : null;
  const onShownRowRef = useRef(onShownRow);
  onShownRowRef.current = onShownRow;
  useEffect(() => {
    onShownRowRef.current?.(shownData ? { data: shownData, row: shownRow } : null);
  }, [shownData, shownRow]);

  if (!run) {
    return <p className="p-3 text-muted">{strings.query.empty(formatShortcut(runShortcut))}</p>;
  }
  const views: { view: View; label: string }[] = [
    { view: "data", label: strings.query.dataTab },
    { view: "message", label: strings.query.messageTab },
  ];
  const ordered = [...run.results].sort((a, b) => a.index - b.index);

  return (
    <div className="flex h-full min-h-0 flex-col bg-content">
      <div
        role="tablist"
        aria-label={strings.query.resultsLabel}
        onKeyDown={onTabListKey}
        className="flex h-8 shrink-0 items-center gap-1 border-b border-grid-sep bg-bottom px-2"
      >
        {views.map((v) => (
          <button
            key={v.view}
            type="button"
            role="tab"
            id={`${uid}-${v.view}`}
            aria-selected={v.view === view}
            aria-controls={`${uid}-panel`}
            tabIndex={v.view === view ? 0 : -1}
            onClick={() => setChosen({ run: run.id, view: v.view })}
            className={tabClass(v.view === view)}
          >
            {v.label}
          </button>
        ))}
        {view === "data" && active && result && (
          <span className="ml-auto truncate text-sm text-text-2">
            {strings.query.resultHeader(result.rows.length, active.outcome.elapsedMs, result.truncated)}
          </span>
        )}
      </div>
      <div
        role="tabpanel"
        id={`${uid}-panel`}
        aria-labelledby={`${uid}-${view}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {view === "data" ? (
          <>
            {sets.length > 1 && (
              <div
                role="tablist"
                aria-label={strings.query.resultSetsLabel}
                onKeyDown={onTabListKey}
                className="flex shrink-0 gap-1 border-b border-grid-sep px-2 py-1"
              >
                {sets.map((r, n) => (
                  <button
                    key={r.index}
                    type="button"
                    role="tab"
                    id={`${uid}-set-${r.index}`}
                    aria-selected={r === active}
                    aria-controls={`${uid}-set-panel`}
                    tabIndex={r === active ? 0 : -1}
                    onClick={() => setSelected({ run: run.id, index: r.index })}
                    className={tabClass(r === active)}
                  >
                    {strings.query.resultTab(n + 1)}
                  </button>
                ))}
              </div>
            )}
            {result ? (
              <div
                className="min-h-0 flex-1"
                // With several sets, the grid is the panel of the "Result N" tabs.
                {...(sets.length > 1 && {
                  role: "tabpanel",
                  id: `${uid}-set-panel`,
                  "aria-labelledby": `${uid}-set-${active?.index}`,
                })}
              >
                <DataGrid
                  data={result}
                  sortable={false}
                  onSelectRow={(row) => setPick({ data: result, row })}
                  onToggleDetails={onToggleDetails}
                  focusRequest={focusRequest}
                />
              </div>
            ) : (
              <p className="p-3 text-sm text-text-2">{run.running ? strings.query.running : strings.query.noData}</p>
            )}
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-sm">
            {ordered.map((r) => (
              <p key={r.index}>
                {r.outcome.result
                  ? strings.query.statementRows(
                      r.index + 1,
                      r.outcome.result.rows.length,
                      r.outcome.elapsedMs,
                      r.outcome.result.truncated,
                    )
                  : r.outcome.rowsAffected === null
                    ? strings.query.done(r.index + 1, r.outcome.elapsedMs)
                    : strings.query.rowsAffected(r.index + 1, r.outcome.rowsAffected, r.outcome.elapsedMs)}
              </p>
            ))}
            {run.running && <p className="text-text-2">{strings.query.running}</p>}
            {run.cancelled && <p className="text-text-2">{strings.query.cancelled}</p>}
            {run.error && (
              <p role="alert" className="break-words text-danger-text">
                {run.error.index === null
                  ? strings.query.failedNoIndex(run.error.message)
                  : strings.query.failed(run.error.index + 1, run.error.message)}
              </p>
            )}
            {run.error?.kind === "connectionLost" && <p className="text-text-2">{strings.query.connectionLostHint}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
