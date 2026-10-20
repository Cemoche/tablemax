import { type MouseEvent, useEffect, useState } from "react";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { HistoryEntry } from "../../lib/types";
import { useChrome } from "../../stores/chrome";
import type { Workspace } from "../../stores/workspaces";
import { ContextMenu, type MenuAnchor, keyboardMenuAnchor } from "../sidebar/ContextMenu";
import { SidebarSearch } from "../sidebar/SidebarSearch";
import { copyText, insertSql, openSqlTab, runSqlInNewTab } from "../sidebar/sqlActions";
import { ConfirmDialog } from "./Dialogs";

/** Entries per request (the backend keeps up to 1,000 per connection). */
export const HISTORY_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 250;

const M = strings.sqlMenu;

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

/**
 * The sidebar's History tab: the connection's query history. A click opens the entry in a
 * new SQL tab; the context menu runs, copies, inserts it in the SQL tab on screen or
 * deletes it. The SQL text may hold sensitive values: it is only displayed, never logged,
 * and "Clear history" removes it.
 */
export function HistoryPanel({ workspace }: { workspace: Workspace }) {
  const { connectionId, id: wsId } = workspace;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [reload, setReload] = useState(0);
  /** The open menu and its entry's button (the focus goes back there on close). */
  const [menu, setMenu] = useState<{ entry: HistoryEntry; anchor: MenuAnchor; trigger: HTMLElement } | null>(null);
  // A run of this connection ended (any tab, any workspace): the backend recorded it.
  const bumps = useChrome((s) => s.historyBumps[connectionId] ?? 0);

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
  }, [connectionId, query, bumps, reload]);

  const clear = async () => {
    setConfirmClear(false);
    try {
      await ipc.historyClear(connectionId);
      setReload((n) => n + 1);
    } catch {
      setError(strings.history.clearFailed);
    }
  };

  const remove = async (entry: HistoryEntry) => {
    try {
      await ipc.historyDelete(connectionId, entry.id);
      setReload((n) => n + 1);
    } catch {
      setError(strings.history.deleteFailed);
    }
  };

  const menuItems = (entry: HistoryEntry) => [
    { label: M.run, run: () => runSqlInNewTab(wsId, entry.sql) },
    { label: M.copy, run: () => void copyText(entry.sql).catch(() => setError(strings.history.copyFailed)) },
    { label: M.insert, run: () => insertSql(wsId, entry.sql) },
    { label: M.delete, run: () => void remove(entry) },
  ];

  const now = Date.now();
  const H = strings.history;
  return (
    <section aria-label={H.label} className="flex min-h-0 flex-1 flex-col">
      <SidebarSearch label={H.search} placeholder={H.searchPlaceholder} value={search} onChange={setSearch} />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {error && <p className="px-1.5 py-1 text-danger">{error}</p>}
        {entries === null && !error && <p className="px-1.5 py-1 text-text-2">{H.loading}</p>}
        {entries?.length === 0 && <p className="px-1.5 py-1 text-text-2">{query ? H.noMatch : H.empty}</p>}
        {entries && entries.length > 0 && (
          <ul>
            {entries.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  title={H.itemHint}
                  onClick={() => openSqlTab(wsId, h.sql)}
                  onContextMenu={(e: MouseEvent<HTMLButtonElement>) => {
                    e.preventDefault();
                    setMenu({ entry: h, anchor: { x: e.clientX, y: e.clientY }, trigger: e.currentTarget });
                  }}
                  onKeyDown={(e) => {
                    const anchor = keyboardMenuAnchor(e);
                    if (anchor) setMenu({ entry: h, anchor, trigger: e.currentTarget });
                  }}
                  className="block w-full rounded-md px-1.5 py-1 text-left outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="line-clamp-2 font-mono text-sm break-all whitespace-pre-wrap text-text">{h.sql}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-text-2">
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
      <div className="px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setConfirmClear(true)}
          disabled={!entries || entries.length === 0}
          className="rounded-md border border-pill-border bg-btn px-2 py-0.5 text-sm text-danger outline-none hover:bg-seg-sel disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          {H.clear}
        </button>
      </div>
      {menu && (
        <ContextMenu
          label={H.menuLabel}
          anchor={menu.anchor}
          items={menuItems(menu.entry)}
          onClose={() => {
            setMenu(null);
            if (menu.trigger.isConnected) menu.trigger.focus();
          }}
        />
      )}
      {confirmClear && (
        <ConfirmDialog
          title={H.clearTitle}
          body={H.clearBody(workspace.name)}
          confirm={H.clearConfirm}
          cancel={H.cancel}
          danger
          onConfirm={() => void clear()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </section>
  );
}
