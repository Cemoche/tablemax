import { useChrome } from "../../stores/chrome";
import { useWorkspaces } from "../../stores/workspaces";

/**
 * What the sidebar's Queries and History do with a SQL text: open it in a new SQL tab,
 * run it there, insert it in the SQL tab on screen, copy it.
 */

function activeTab(wsId: string) {
  const ws = useWorkspaces.getState().workspaces.find((w) => w.id === wsId);
  return ws?.tabs.find((t) => t.id === ws.activeTabId) ?? null;
}

/** A new SQL tab holding `sql`, made active. */
export function openSqlTab(wsId: string, sql: string): void {
  useWorkspaces.getState().openQueryTab(wsId, sql);
}

/** Asks the active tab (a SQL tab just opened or activated) to run all of its text. */
export function runActiveTab(wsId: string): void {
  const tab = activeTab(wsId);
  if (tab?.kind === "query") useChrome.getState().requestRun(tab.id);
}

/** A new SQL tab with `sql`, which runs at once (safe mode still asks first). */
export function runSqlInNewTab(wsId: string, sql: string): void {
  openSqlTab(wsId, sql);
  runActiveTab(wsId);
}

/** At the cursor of the SQL tab on screen; with none, in a new SQL tab. */
export function insertSql(wsId: string, sql: string): void {
  const tab = activeTab(wsId);
  if (tab?.kind === "query") useChrome.getState().requestInsert(tab.id, sql);
  else openSqlTab(wsId, sql);
}

/** Copies `text`; a refused clipboard rejects (callers report it). */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
}
