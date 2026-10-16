import { create } from "zustand";
import type { AppError, ErrorKind, ExecEvent, StatementOutcome } from "../lib/types";

export interface StatementResult {
  /** Index within the batch that was sent (0-based). */
  index: number;
  outcome: StatementOutcome;
}

export interface QueryRun {
  running: boolean;
  /** Number of statements in the batch. */
  total: number;
  results: StatementResult[];
  /** `index` is null for errors not tied to a statement (e.g. a rejected batch). */
  error: { index: number | null; kind: ErrorKind; message: string } | null;
  cancelled: boolean;
}

interface QueryRunsState {
  runs: Record<string, QueryRun>;
  start: (tabId: string, total: number) => void;
  applyEvent: (tabId: string, e: ExecEvent) => void;
  /** The execute call itself rejected (unknown session, query already running...). */
  preflightFailed: (tabId: string, error: AppError) => void;
  drop: (tabId: string) => void;
}

/**
 * Per-query-tab run state, outside the component so it survives tab switches and keeps
 * receiving channel events while the tab is unmounted. The end of a batch is the
 * `batchFinished` event, never the execute promise.
 */
export const useQueryRuns = create<QueryRunsState>((set) => {
  const patch = (tabId: string, fn: (r: QueryRun) => QueryRun) =>
    set((s) => {
      const r = s.runs[tabId];
      return r ? { runs: { ...s.runs, [tabId]: fn(r) } } : s;
    });

  return {
    runs: {},
    start: (tabId, total) =>
      set((s) => ({
        runs: {
          ...s.runs,
          [tabId]: { running: true, total, results: [], error: null, cancelled: false },
        },
      })),
    applyEvent: (tabId, e) =>
      patch(tabId, (r) => {
        switch (e.event) {
          case "statementStarted":
            return r;
          case "statementFinished":
            return {
              ...r,
              results: [...r.results, { index: e.data.index, outcome: e.data.outcome }],
            };
          case "statementFailed":
            return {
              ...r,
              error: { index: e.data.index, kind: e.data.error.kind, message: e.data.error.message },
            };
          case "batchFinished":
            return { ...r, running: false, cancelled: e.data.cancelled };
        }
      }),
    preflightFailed: (tabId, error) =>
      patch(tabId, (r) =>
        r.running
          ? { ...r, running: false, error: { index: null, kind: error.kind, message: error.message } }
          : r,
      ),
    drop: (tabId) =>
      set((s) => {
        if (!(tabId in s.runs)) return s;
        const runs = { ...s.runs };
        delete runs[tabId];
        return { runs };
      }),
  };
});
