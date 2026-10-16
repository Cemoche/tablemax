import { useState } from "react";
import { strings } from "../../lib/strings";
import type { QueryRun } from "../../stores/queryRuns";
import { DataGrid } from "../grid/DataGrid";

export function ResultsPanel({ run }: { run: QueryRun | undefined }) {
  const [selected, setSelected] = useState<number | null>(null);

  if (!run) {
    return <p className="p-3 text-muted">{strings.query.empty}</p>;
  }

  const sets = run.results.filter((r) => r.outcome.result);
  const others = run.results.filter((r) => !r.outcome.result);
  const active = sets.find((r) => r.index === selected) ?? sets[0];
  const result = active?.outcome.result;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sets.length > 0 && (
        <div role="tablist" aria-label={strings.query.resultsLabel} className="flex border-b border-border bg-surface">
          {sets.map((r, n) => (
            <button
              key={r.index}
              type="button"
              role="tab"
              aria-selected={r === active}
              onClick={() => setSelected(r.index)}
              className={`px-3 py-1 text-sm ${
                r === active ? "border-b-2 border-accent text-fg" : "text-muted hover:bg-surface-2"
              }`}
            >
              {strings.query.resultTab(n + 1)}
            </button>
          ))}
        </div>
      )}
      {active && result && (
        <>
          <div className="border-b border-border px-3 py-1 text-sm text-muted">
            {strings.query.resultHeader(result.rows.length, active.outcome.elapsedMs)}
          </div>
          <div className="min-h-0 flex-1">
            <DataGrid data={result} sortable={false} />
          </div>
        </>
      )}
      {sets.length === 0 && <div className="min-h-0 flex-1" />}
      {(others.length > 0 || run.error || run.cancelled || run.running) && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-border bg-surface px-3 py-1 text-sm">
          {others.map((r) => (
            <p key={r.index}>
              {r.outcome.rowsAffected === null
                ? strings.query.done(r.index + 1, r.outcome.elapsedMs)
                : strings.query.rowsAffected(r.index + 1, r.outcome.rowsAffected, r.outcome.elapsedMs)}
            </p>
          ))}
          {run.running && <p className="text-muted">{strings.query.running}</p>}
          {run.cancelled && <p className="text-muted">{strings.query.cancelled}</p>}
          {run.error && (
            <p role="alert" className="break-words text-danger">
              {run.error.index === null
                ? strings.query.failedNoIndex(run.error.message)
                : strings.query.failed(run.error.index + 1, run.error.message)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
