import { type MouseEvent, useEffect, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { HistoryEntry } from "../../lib/types";
import { ConfirmDialog } from "./Dialogs";

/** Entries per request (the backend keeps up to 1,000 per connection). */
export const HISTORY_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 250;
/** A click waits this long to tell a single click (insert) from a double-click (replace). */
const CLICK_DELAY_MS = 250;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "2 minutes ago", "now"… (under a minute is "now"). */
export function relativeTime(at: number, now: number): string {
  const diff = at - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return strings.history.relative(Math.round(diff / ms), unit);
  }
  return strings.history.relative(0, "second");
}

interface Props {
  connectionId: string;
  /** Shown in the "Clear history" confirmation. */
  connectionName: string;
  /** Changes when a run finished: the backend recorded new entries. */
  refreshKey?: number;
  /** Click: insert the SQL at the editor cursor. */
  onInsert: (sql: string) => void;
  /** Double-click: replace the editor content. */
  onReplace: (sql: string) => void;
  onClose?: () => void;
}

/**
 * The connection's query history (right side of the SQL tab). The SQL text may hold
 * sensitive values: it is only displayed, never logged, and "Clear history" removes it.
 */
export function HistoryPanel({ connectionId, connectionName, refreshKey = 0, onInsert, onReplace, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [reload, setReload] = useState(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = await ipc.historyList(connectionId, query || null, HISTORY_LIMIT);
        if (!live) return;
        setEntries(Array.isArray(list) ? list : []);
        setError(null);
      } catch {
        if (live) setError(strings.history.loadFailed);
      }
    })();
    return () => {
      live = false;
    };
  }, [connectionId, query, refreshKey, reload]);

  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  const onItemClick = (e: MouseEvent, sql: string) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = null;
    if (e.detail === 0) return onInsert(sql); // keyboard
    if (e.detail === 1) {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        onInsert(sql);
      }, CLICK_DELAY_MS);
    }
  };
  const onItemDoubleClick = (sql: string) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = null;
    onReplace(sql);
  };

  const clear = async () => {
    setConfirmClear(false);
    try {
      await ipc.historyClear(connectionId);
      setReload((n) => n + 1);
    } catch {
      setError(strings.history.clearFailed);
    }
  };

  const now = Date.now();
  const H = strings.history;
  return (
    <aside aria-label={H.label} className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <input
          type="search"
          aria-label={H.search}
          placeholder={H.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-0.5 text-sm"
        />
        {onClose && (
          <button
            type="button"
            aria-label={H.close}
            title={H.close}
            onClick={onClose}
            className="rounded-sm px-1.5 hover:bg-surface-2"
          >
            {H.closeIcon}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && <p className="p-2 text-sm text-danger">{error}</p>}
        {entries === null && !error && <p className="p-2 text-sm text-muted">{H.loading}</p>}
        {entries?.length === 0 && <p className="p-2 text-sm text-muted">{query ? H.noMatch : H.empty}</p>}
        {entries && entries.length > 0 && (
          <ul>
            {entries.map((h) => (
              <li key={h.id} className="border-b border-border">
                <button
                  type="button"
                  title={H.itemHint}
                  onClick={(e) => onItemClick(e, h.sql)}
                  onDoubleClick={() => onItemDoubleClick(h.sql)}
                  className="block w-full px-2 py-1 text-left hover:bg-surface-2"
                >
                  <span className="line-clamp-3 font-mono text-sm break-all whitespace-pre-wrap">{h.sql}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                    <span>{relativeTime(h.executedAt, now)}</span>
                    {h.elapsedMs !== null && <span>{H.duration(h.elapsedMs)}</span>}
                    {h.rows !== null && <span>{H.rows(h.rows)}</span>}
                  </span>
                  {h.error && <span className="mt-0.5 block text-xs break-words text-danger">{h.error}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-border px-2 py-1">
        <button
          type="button"
          onClick={() => setConfirmClear(true)}
          disabled={!entries || entries.length === 0}
          className="rounded-sm border border-border px-2 py-0.5 text-sm text-danger hover:bg-surface-2 disabled:opacity-40"
        >
          {H.clear}
        </button>
      </div>
      {confirmClear && (
        <ConfirmDialog
          title={H.clearTitle}
          body={H.clearBody(connectionName)}
          confirm={H.clearConfirm}
          cancel={H.cancel}
          danger
          onConfirm={() => void clear()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </aside>
  );
}
