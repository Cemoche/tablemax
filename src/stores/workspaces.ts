import { create } from "zustand";
import * as ipc from "../lib/ipc";
import { strings } from "../lib/strings";
import type { ConnectionConfig, Dialect, EnvTag, ObjectRef } from "../lib/types";
import { useConnections } from "./connections";
import { useGridViews } from "./gridViews";
import { useQueryRuns } from "./queryRuns";

export type Tab =
  | { id: string; kind: "table"; object: ObjectRef; title: string; preview: boolean }
  | { id: string; kind: "query"; title: string; sql: string; sqlSessionId: string | null };

export interface Workspace {
  id: string;
  connectionId: string;
  name: string;
  color: string;
  envTag: EnvTag;
  dialect: Dialect;
  schemas: string[];
  currentSchema: string | null;
  tabs: Tab[];
  activeTabId: string | null;
  /** Tab ids, most recently used first. */
  mru: string[];
}

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Secrets typed by the user; `acceptFingerprint` trusts a confirmed unknown host key. */
  openWorkspace: (
    connectionId: string,
    password?: string | null,
    sshSecret?: string | null,
    acceptFingerprint?: string | null,
  ) => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
  setActiveWorkspace: (id: string) => void;
  setSchema: (wsId: string, schema: string) => void;
  /**
   * `preview: true` (sidebar single click) reuses the workspace's one preview tab;
   * the default opens a pinned tab. An object already open is just activated
   * (and pinned when opened without `preview`).
   */
  openTableTab: (wsId: string, object: ObjectRef, opts?: { preview?: boolean }) => void;
  /** Turns a preview tab into a regular one (no-op otherwise). */
  pinTab: (wsId: string, tabId: string) => void;
  openQueryTab: (wsId: string) => void;
  closeTab: (wsId: string, tabId: string) => void;
  activateTab: (wsId: string, tabId: string) => void;
  /** Patches a query tab (no-op for table tabs). */
  updateTab: (
    wsId: string,
    tabId: string,
    patch: Partial<{ sql: string; sqlSessionId: string | null; title: string }>,
  ) => void;
}

/** Per-workspace query counter: never reused, even after tabs close. */
const queryCounters = new Map<string, number>();
/** In-flight opens, so a double click does not open two backend workspaces. */
const opening = new Map<string, Promise<void>>();

export function defaultSchema(
  dialect: Dialect,
  schemas: string[],
  database: string | null,
): string | null {
  const pick = (name: string | null) => (name && schemas.includes(name) ? name : null);
  switch (dialect) {
    case "postgres":
      return pick("public") ?? schemas[0] ?? null;
    case "mySql":
      return pick(database) ?? schemas[0] ?? null;
    case "sqlite":
      return pick("main") ?? schemas[0] ?? null;
  }
}

const touch = (mru: string[], id: string) => [id, ...mru.filter((x) => x !== id)];

const sameObject = (a: ObjectRef, b: ObjectRef) => a.schema === b.schema && a.name === b.name;

export const useWorkspaces = create<WorkspacesState>((set, get) => {
  const update = (wsId: string, fn: (w: Workspace) => Workspace) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === wsId ? fn(w) : w)) }));

  const doOpen = async (
    cfg: ConnectionConfig,
    password: string | null,
    sshSecret: string | null,
    acceptFingerprint: string | null,
  ) => {
    const info = await ipc.workspaceOpen(cfg.id, password, sshSecret, acceptFingerprint);
    let schemas: string[];
    try {
      schemas = await ipc.schemasList(info.workspaceId);
    } catch (e) {
      void ipc.workspaceClose(info.workspaceId).catch(() => {});
      throw e;
    }
    const ws: Workspace = {
      id: info.workspaceId,
      connectionId: cfg.id,
      name: cfg.name,
      color: cfg.color,
      envTag: cfg.envTag,
      dialect: info.dialect,
      schemas,
      currentSchema: defaultSchema(info.dialect, schemas, cfg.database),
      tabs: [],
      activeTabId: null,
      mru: [],
    };
    queryCounters.delete(ws.id);
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }));
  };

  return {
    workspaces: [],
    activeWorkspaceId: null,

    openWorkspace: async (
      connectionId,
      password = null,
      sshSecret = null,
      acceptFingerprint = null,
    ) => {
      const existing = get().workspaces.find((w) => w.connectionId === connectionId);
      if (existing) {
        set({ activeWorkspaceId: existing.id });
        return;
      }
      const inflight = opening.get(connectionId);
      if (inflight) return inflight;
      const cfg = useConnections.getState().items.find((c) => c.id === connectionId);
      if (!cfg) throw { kind: "notFound", message: strings.workspace.openFailed };
      const p = doOpen(cfg, password, sshSecret, acceptFingerprint).finally(() => opening.delete(connectionId));
      opening.set(connectionId, p);
      return p;
    },

    closeWorkspace: async (id) => {
      // Backend workspaceClose also closes the workspace's SQL sessions.
      queryCounters.delete(id);
      for (const t of get().workspaces.find((w) => w.id === id)?.tabs ?? []) {
        useGridViews.getState().dropView(t.id);
        useQueryRuns.getState().drop(t.id);
      }
      set((s) => {
        const idx = s.workspaces.findIndex((w) => w.id === id);
        const workspaces = s.workspaces.filter((w) => w.id !== id);
        const activeWorkspaceId =
          s.activeWorkspaceId === id
            ? (workspaces[Math.min(idx, workspaces.length - 1)]?.id ?? null)
            : s.activeWorkspaceId;
        return { workspaces, activeWorkspaceId };
      });
      await ipc.workspaceClose(id);
    },

    setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

    setSchema: (wsId, schema) => update(wsId, (w) => ({ ...w, currentSchema: schema })),

    openTableTab: (wsId, object, opts) => {
      const preview = opts?.preview ?? false;
      let dropped: string | null = null;
      update(wsId, (w) => {
        const existing = w.tabs.find((t) => t.kind === "table" && sameObject(t.object, object));
        if (existing) {
          const tabs =
            !preview && existing.kind === "table" && existing.preview
              ? w.tabs.map((t) => (t.id === existing.id ? { ...existing, preview: false } : t))
              : w.tabs;
          return { ...w, tabs, activeTabId: existing.id, mru: touch(w.mru, existing.id) };
        }
        const tab: Tab = {
          id: crypto.randomUUID(),
          kind: "table",
          object,
          title: object.name,
          preview,
        };
        const old = preview ? w.tabs.find((t) => t.kind === "table" && t.preview) : undefined;
        let tabs: Tab[];
        let mru = w.mru;
        if (old) {
          dropped = old.id;
          tabs = w.tabs.map((t) => (t.id === old.id ? tab : t));
          mru = mru.filter((x) => x !== old.id);
        } else {
          tabs = [...w.tabs, tab];
        }
        return { ...w, tabs, activeTabId: tab.id, mru: touch(mru, tab.id) };
      });
      if (dropped) useGridViews.getState().dropView(dropped);
    },

    pinTab: (wsId, tabId) =>
      update(wsId, (w) => {
        const t = w.tabs.find((x) => x.id === tabId);
        if (!t || t.kind !== "table" || !t.preview) return w;
        return { ...w, tabs: w.tabs.map((x) => (x.id === tabId ? { ...t, preview: false } : x)) };
      }),

    openQueryTab: (wsId) =>
      update(wsId, (w) => {
        const n = (queryCounters.get(wsId) ?? 0) + 1;
        queryCounters.set(wsId, n);
        const tab: Tab = {
          id: crypto.randomUUID(),
          kind: "query",
          title: strings.workspace.queryTitle(n),
          sql: "",
          sqlSessionId: null,
        };
        return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id, mru: touch(w.mru, tab.id) };
      }),

    closeTab: (wsId, tabId) => {
      const ws = get().workspaces.find((w) => w.id === wsId);
      const tab = ws?.tabs.find((t) => t.id === tabId);
      if (!ws || !tab) return;
      if (tab.kind === "query" && tab.sqlSessionId) {
        void ipc.sqlSessionClose(tab.sqlSessionId)?.catch(() => {});
      }
      useGridViews.getState().dropView(tabId);
      useQueryRuns.getState().drop(tabId);
      update(wsId, (w) => {
        const idx = w.tabs.findIndex((t) => t.id === tabId);
        const tabs = w.tabs.filter((t) => t.id !== tabId);
        const mru = w.mru.filter((x) => x !== tabId && tabs.some((t) => t.id === x));
        const activeTabId =
          w.activeTabId === tabId
            ? (mru[0] ?? (tabs[idx] ?? tabs[idx - 1])?.id ?? null)
            : w.activeTabId;
        return { ...w, tabs, activeTabId, mru };
      });
    },

    activateTab: (wsId, tabId) =>
      update(wsId, (w) =>
        w.tabs.some((t) => t.id === tabId)
          ? { ...w, activeTabId: tabId, mru: touch(w.mru, tabId) }
          : w,
      ),

    updateTab: (wsId, tabId, patch) =>
      update(wsId, (w) => ({
        ...w,
        tabs: w.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, ...patch } : t)),
      })),
  };
});

// First sort or page change in a preview tab pins it (Plan 4, ruling R1). Editing and
// filtering call `pinTab` themselves once they exist.
useGridViews.subscribe((state, prev) => {
  for (const tabId of Object.keys(state.views)) {
    if (state.views[tabId] === prev.views[tabId]) continue;
    for (const w of useWorkspaces.getState().workspaces) {
      if (w.tabs.some((t) => t.id === tabId && t.kind === "table" && t.preview)) {
        useWorkspaces.getState().pinTab(w.id, tabId);
      }
    }
  }
});
