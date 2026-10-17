import { create } from "zustand";
import * as ipc from "../lib/ipc";
import type { SavedQuery } from "../lib/types";
import { useWorkspaces } from "./workspaces";

/**
 * Saved queries per connection (files managed by the backend, Plan 4 Task 8). Every
 * mutation goes through the backend first (it validates the name and confines the file
 * to the connection's folder), then the linked query tabs follow and the list reloads.
 * Failures reject with the backend's AppError for the caller to show.
 */
interface SavedQueriesState {
  /** Connection id -> saved queries, as last listed. */
  lists: Record<string, SavedQuery[]>;
  load: (connectionId: string) => Promise<void>;
  /** Writes `sql` as `name` and links the tab to it (its title becomes `name`). */
  saveTab: (wsId: string, tabId: string, name: string, sql: string) => Promise<void>;
  rename: (connectionId: string, from: string, to: string) => Promise<void>;
  remove: (connectionId: string, name: string) => Promise<void>;
  /** Activates the tab linked to `name`, else reads it into a new linked tab. */
  open: (wsId: string, name: string) => Promise<void>;
}

/** Patches every query tab of `connectionId` linked to `name`. */
function patchLinked(
  connectionId: string,
  name: string,
  patch: (title: string) => Partial<{ title: string; savedName: string | null; savedSql: string | null }>,
) {
  const st = useWorkspaces.getState();
  for (const w of st.workspaces) {
    if (w.connectionId !== connectionId) continue;
    for (const t of w.tabs) {
      if (t.kind === "query" && t.savedName === name) st.updateTab(w.id, t.id, patch(t.title));
    }
  }
}

export const useSavedQueries = create<SavedQueriesState>((set, get) => ({
  lists: {},

  load: async (connectionId) => {
    const list = await ipc.savedQueriesList(connectionId);
    set((s) => ({ lists: { ...s.lists, [connectionId]: Array.isArray(list) ? list : [] } }));
  },

  saveTab: async (wsId, tabId, name, sql) => {
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    await ipc.savedQueryWrite(ws.connectionId, name, sql);
    useWorkspaces.getState().updateTab(wsId, tabId, { title: name, savedName: name, savedSql: sql });
    await get().load(ws.connectionId).catch(() => {});
  },

  rename: async (connectionId, from, to) => {
    await ipc.savedQueryRename(connectionId, from, to);
    // A tab still titled after the query follows the new name.
    patchLinked(connectionId, from, (title) => (title === from ? { title: to, savedName: to } : { savedName: to }));
    await get().load(connectionId).catch(() => {});
  },

  remove: async (connectionId, name) => {
    await ipc.savedQueryDelete(connectionId, name);
    // The tabs keep their text and title, they are just no longer linked.
    patchLinked(connectionId, name, () => ({ savedName: null, savedSql: null }));
    await get().load(connectionId).catch(() => {});
  },

  open: async (wsId, name) => {
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const linked = ws.tabs.find((t) => t.kind === "query" && t.savedName === name);
    if (linked) {
      useWorkspaces.getState().activateTab(wsId, linked.id);
      return;
    }
    const sql = await ipc.savedQueryRead(ws.connectionId, name);
    useWorkspaces.getState().openSavedQueryTab(wsId, name, sql);
  },
}));
