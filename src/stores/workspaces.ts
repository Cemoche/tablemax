import { create } from "zustand";
import * as ipc from "../lib/ipc";
import { strings } from "../lib/strings";
import type { ConnectionConfig, Dialect, EnvTag, ObjectRef, SafeMode } from "../lib/types";
import { useConnections } from "./connections";
import { type GridView, type TrailEntry, useGridViews } from "./gridViews";
import { usePendingChanges } from "./pendingChanges";
import { useQueryRuns } from "./queryRuns";

export type Tab =
  | { id: string; kind: "table"; object: ObjectRef; title: string }
  | { id: string; kind: "query"; title: string; sql: string; sqlSessionId: string | null };

export interface Workspace {
  id: string;
  connectionId: string;
  name: string;
  color: string;
  /** Tag and safe mode the workspace was opened with (the saved connection may change since). */
  envTag: EnvTag;
  safeMode?: SafeMode | null;
  dialect: Dialect;
  schemas: string[];
  currentSchema: string | null;
  tabs: Tab[];
  activeTabId: string | null;
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
  /** Asks first (closeRequest) when tabs of the workspace have pending changes. */
  closeWorkspace: (id: string) => Promise<void>;
  setActiveWorkspace: (id: string) => void;
  setSchema: (wsId: string, schema: string) => void;
  openTableTab: (wsId: string, object: ObjectRef) => void;
  /**
   * Shows another table in a table tab (foreign key navigation): its object and title,
   * and its view and trail (gridViews), in one action. Callers check pending changes
   * first (features/grid/tableNavigation). No-op for a query tab.
   */
  navigateTableTab: (
    wsId: string,
    tabId: string,
    object: ObjectRef,
    view: GridView,
    trail: TrailEntry[],
  ) => void;
  openQueryTab: (wsId: string) => void;
  /**
   * Closes a tab. A table tab with pending changes is not closed: `closeRequest` asks the
   * user first (confirmClose / cancelClose).
   */
  closeTab: (wsId: string, tabId: string) => void;
  /**
   * A close waiting for "Discard N pending changes?": a tab (`tabId`), or the whole
   * workspace (`tabId` null; `tabs` = table tabs with pending changes).
   */
  closeRequest: { wsId: string; tabId: string | null; count: number; tabs: number } | null;
  /** Discards the pending changes of `closeRequest` and closes its tab or workspace. */
  confirmClose: () => Promise<void>;
  cancelClose: () => void;
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
      safeMode: cfg.safeMode ?? null,
      dialect: info.dialect,
      schemas,
      currentSchema: defaultSchema(info.dialect, schemas, cfg.database),
      tabs: [],
      activeTabId: null,
    };
    queryCounters.delete(ws.id);
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }));
  };

  const doCloseWorkspace = async (id: string) => {
    // Backend workspaceClose also closes the workspace's SQL sessions.
    queryCounters.delete(id);
    for (const t of get().workspaces.find((w) => w.id === id)?.tabs ?? []) {
      useGridViews.getState().dropView(t.id);
      useQueryRuns.getState().drop(t.id);
      usePendingChanges.getState().drop(t.id);
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
  };

  const doCloseTab = (wsId: string, tabId: string) => {
    const ws = get().workspaces.find((w) => w.id === wsId);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (!ws || !tab) return;
    if (tab.kind === "query" && tab.sqlSessionId) {
      void ipc.sqlSessionClose(tab.sqlSessionId)?.catch(() => {});
    }
    useGridViews.getState().dropView(tabId);
    useQueryRuns.getState().drop(tabId);
    usePendingChanges.getState().drop(tabId);
    update(wsId, (w) => {
      const idx = w.tabs.findIndex((t) => t.id === tabId);
      const tabs = w.tabs.filter((t) => t.id !== tabId);
      const activeTabId =
        w.activeTabId === tabId ? (tabs[idx] ?? tabs[idx - 1])?.id ?? null : w.activeTabId;
      return { ...w, tabs, activeTabId };
    });
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
      const tabs = get().workspaces.find((w) => w.id === id)?.tabs ?? [];
      const counts = tabs
        .filter((t) => t.kind === "table")
        .map((t) => usePendingChanges.getState().count(t.id))
        .filter((n) => n > 0);
      if (counts.length > 0) {
        const count = counts.reduce((a, b) => a + b, 0);
        set({ closeRequest: { wsId: id, tabId: null, count, tabs: counts.length } });
        return;
      }
      await doCloseWorkspace(id);
    },

    setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

    setSchema: (wsId, schema) => update(wsId, (w) => ({ ...w, currentSchema: schema })),

    openTableTab: (wsId, object) =>
      update(wsId, (w) => {
        const existing = w.tabs.find((t) => t.kind === "table" && sameObject(t.object, object));
        if (existing) return { ...w, activeTabId: existing.id };
        const tab: Tab = { id: crypto.randomUUID(), kind: "table", object, title: object.name };
        return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id };
      }),

    navigateTableTab: (wsId, tabId, object, view, trail) => {
      const tab = get().workspaces.find((w) => w.id === wsId)?.tabs.find((t) => t.id === tabId);
      if (tab?.kind !== "table") return;
      // Both stores change before React renders again (one batch).
      useGridViews.getState().setNavigation(tabId, view, trail);
      update(wsId, (w) => ({
        ...w,
        tabs: w.tabs.map((t) => (t.id === tabId && t.kind === "table" ? { ...t, object, title: object.name } : t)),
      }));
    },

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
        return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id };
      }),

    closeTab: (wsId, tabId) => {
      const tab = get().workspaces.find((w) => w.id === wsId)?.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const count = tab.kind === "table" ? usePendingChanges.getState().count(tabId) : 0;
      if (count > 0) {
        set({ closeRequest: { wsId, tabId, count, tabs: 1 } });
        return;
      }
      doCloseTab(wsId, tabId);
    },

    closeRequest: null,

    confirmClose: async () => {
      const req = get().closeRequest;
      set({ closeRequest: null });
      if (!req) return;
      if (req.tabId !== null) doCloseTab(req.wsId, req.tabId);
      else await doCloseWorkspace(req.wsId);
    },

    cancelClose: () => set({ closeRequest: null }),

    activateTab: (wsId, tabId) => update(wsId, (w) => ({ ...w, activeTabId: tabId })),

    updateTab: (wsId, tabId, patch) =>
      update(wsId, (w) => ({
        ...w,
        tabs: w.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, ...patch } : t)),
      })),
  };
});
