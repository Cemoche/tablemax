import { create } from "zustand";
import * as ipc from "../lib/ipc";
import { strings } from "../lib/strings";
import type { Capabilities, ConnectionConfig, Dialect, EnvTag, ObjectRef, SafeMode, WorkspaceInfo } from "../lib/types";
import { useConnections } from "./connections";
import { type GridView, type TrailEntry, useGridViews } from "./gridViews";
import { usePendingChanges } from "./pendingChanges";
import { useQueryRuns } from "./queryRuns";

export type Tab =
  | { id: string; kind: "table"; object: ObjectRef; title: string; preview: boolean }
  | {
      id: string;
      kind: "query";
      title: string;
      sql: string;
      sqlSessionId: string | null;
      /** Saved query this tab is linked to (Mod+S overwrites it); absent/null: none. */
      savedName?: string | null;
      /**
       * Text of the saved query as last saved or read, to show the "modified" dot.
       * `undefined` while unknown (a restored tab before its file was read).
       */
      savedSql?: string | null;
      /**
       * PostgreSQL: the database the tab's SQL session was opened on (absent/null until
       * its first Run). A lost session reopens there, even after the workspace switched
       * database; the tab bar shows it when it differs from the workspace's.
       */
      database?: string | null;
    };

/**
 * `disconnected`: restored from the last session (or a cancelled/failed reconnect); its
 * id is a frontend placeholder until it connects, and nothing may be asked of the
 * backend with it. `connecting`: an open is in flight.
 */
export type WorkspaceStatus = "connected" | "disconnected" | "connecting";

export interface Workspace {
  id: string;
  connectionId: string;
  name: string;
  color: string;
  /** Tag and safe mode the workspace was opened with (the saved connection may change since). */
  envTag: EnvTag;
  safeMode?: SafeMode | null;
  /** Null for a connection without SQL (documents); decide with `capabilitiesOf`, not this. */
  dialect: Dialect | null;
  /**
   * What the connection offers (WorkspaceInfo.capabilities). Absent until the first
   * connect (a restored workspace): read it through `capabilitiesOf`.
   */
  capabilities?: Capabilities;
  status: WorkspaceStatus;
  /** Database the workspace browses (WorkspaceInfo.database); restored as is. */
  database: string | null;
  schemas: string[];
  currentSchema: string | null;
  tabs: Tab[];
  activeTabId: string | null;
  /** Tab ids, most recently used first. */
  mru: string[];
  /** Non-blocking message shown above the tabs until dismissed (absent/null: none). */
  notice?: string | null;
}

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /**
   * Set when the user activates a disconnected workspace (a tab of it, the workspace
   * itself, or Reconnect). App runs the connect flow (with its prompts) and clears it.
   */
  connectRequest: { workspaceId: string } | null;
  /** Secrets typed by the user; `acceptFingerprint` trusts a confirmed unknown host key. */
  openWorkspace: (
    connectionId: string,
    password?: string | null,
    sshSecret?: string | null,
    acceptFingerprint?: string | null,
  ) => Promise<void>;
  /**
   * Asks first (closeRequest) when tabs of the workspace have pending changes; does
   * nothing while one of its tabs is committing (the commit must finish first).
   */
  closeWorkspace: (id: string) => Promise<void>;
  /** A commit is running in the tab (`tabId`), or in any tab of the workspace. */
  isCommitting: (wsId: string, tabId?: string) => boolean;
  /** Selecting a disconnected workspace requests its connect. */
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
  /** `sql` is the initial content of the new tab (default empty). */
  openQueryTab: (wsId: string, sql?: string) => void;
  /**
   * PostgreSQL only: switches the workspace's database, closes its table tabs (they
   * would otherwise query the new database under the old title; query tabs stay, they
   * keep their own SQL sessions), then reloads its schemas and resets the current
   * schema. Rejects with the workspace unchanged when the switch itself fails. Once the
   * switch succeeded the store follows the backend: a schemas failure leaves no schemas
   * and rejects. A second call while one runs for the same workspace is ignored. Rejects
   * with `invalid` and calls nothing while a table tab has pending changes.
   */
  switchDatabase: (wsId: string, database: string) => Promise<void>;
  /**
   * Closes a tab. A table tab with pending changes is not closed: `closeRequest` asks the
   * user first (confirmClose / cancelClose). A tab whose commit is running is not closed.
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
  /** Activating a tab of a disconnected workspace requests its connect. */
  activateTab: (wsId: string, tabId: string) => void;
  /** Patches a query tab (no-op for table tabs). */
  updateTab: (
    wsId: string,
    tabId: string,
    patch: Partial<{
      sql: string;
      sqlSessionId: string | null;
      title: string;
      savedName: string | null;
      savedSql: string | null;
      database: string | null;
    }>,
  ) => void;
  /** Hides the workspace's notice. */
  dismissNotice: (wsId: string) => void;
  /**
   * Adds restored (disconnected) workspaces, skipping connections already open, and
   * activates `activeId` unless a workspace is already active.
   */
  restoreWorkspaces: (workspaces: Workspace[], activeId: string | null) => void;
  /** Asks App to connect a disconnected workspace (no-op otherwise). */
  requestConnect: (wsId: string) => void;
  clearConnectRequest: () => void;
  /**
   * Activates the query tab linked to the saved query `name`, else opens a new query tab
   * titled `name` with `sql`, linked to it (Plan 4 Task 8).
   */
  openSavedQueryTab: (wsId: string, name: string, sql: string) => void;
  /** App-level: is the object sidebar shown? (the palette's "Toggle sidebar") */
  sidebarVisible: boolean;
  toggleSidebar: () => void;
}

/** True when a query tab linked to a saved query differs from the saved text. */
export function isQueryModified(tab: Tab): boolean {
  return tab.kind === "query" && !!tab.savedName && typeof tab.savedSql === "string" && tab.savedSql !== tab.sql;
}

/** Per-workspace query counter: never reused, even after tabs close. */
const queryCounters = new Map<string, number>();
/** In-flight opens, so a double click does not open two backend workspaces. */
const opening = new Map<string, Promise<void>>();
/** Workspaces with a database switch in flight. */
const switching = new Set<string>();

/** The capabilities of a SQL connection of `dialect` (mirror of `driver::capabilities`). */
export function sqlCapabilities(dialect: Dialect): Capabilities {
  return {
    sqlEditor: true,
    gridEditing: true,
    routines: true,
    ddl: true,
    foreignKeys: true,
    documents: false,
    databaseSwitch: dialect === "postgres",
  };
}

/** The capabilities of a document connection (mirror of `driver::capabilities(MongoDb)`). */
export const documentCapabilities: Capabilities = {
  sqlEditor: false,
  gridEditing: false,
  routines: false,
  ddl: false,
  foreignKeys: false,
  documents: true,
  databaseSwitch: false,
};

/**
 * What the interface may offer on `w`: what its connection reported, else (before its
 * first connect) the SQL capabilities of its dialect, or the document capabilities
 * when it has none (MongoDB).
 */
export function capabilitiesOf(w: Pick<Workspace, "capabilities" | "dialect">): Capabilities {
  return w.capabilities ?? (w.dialect ? sqlCapabilities(w.dialect) : documentCapabilities);
}

/**
 * The dialect of a workspace whose capabilities offer SQL. SQL components are only
 * rendered for those, so a missing dialect is a bug, not a state to show.
 */
export function sqlDialect(w: Pick<Workspace, "dialect">): Dialect {
  if (w.dialect === null) throw new Error("SQL component on a connection without SQL");
  return w.dialect;
}

export function defaultSchema(
  dialect: Dialect | null,
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
    default:
      return schemas[0] ?? null;
  }
}

const touch = (mru: string[], id: string) => [id, ...mru.filter((x) => x !== id)];

const sameObject = (a: ObjectRef, b: ObjectRef) => a.schema === b.schema && a.name === b.name;

/** The highest `n` of the query tabs titled `strings.workspace.queryTitle(n)`. */
function lastQueryNumber(tabs: Tab[]): number {
  let max = 0;
  for (const t of tabs) {
    if (t.kind !== "query") continue;
    const n = Number(/(\d+)\D*$/.exec(t.title)?.[1]);
    if (Number.isSafeInteger(n) && strings.workspace.queryTitle(n) === t.title) max = Math.max(max, n);
  }
  return max;
}

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
      capabilities: info.capabilities,
      status: "connected",
      database: info.database,
      schemas,
      currentSchema: defaultSchema(info.dialect, schemas, cfg.database),
      tabs: [],
      activeTabId: null,
      mru: [],
    };
    queryCounters.delete(ws.id);
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }));
  };

  const doCloseWorkspace = async (id: string) => {
    // Backend workspaceClose also closes the workspace's SQL sessions.
    queryCounters.delete(id);
    const closing = get().workspaces.find((w) => w.id === id);
    for (const t of closing?.tabs ?? []) {
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
      const connectRequest = s.connectRequest?.workspaceId === id ? null : s.connectRequest;
      return { workspaces, activeWorkspaceId, connectRequest };
    });
    // A placeholder id means nothing to the backend; a workspace still connecting is
    // closed by its open when it arrives.
    if (closing?.status === "connected") await ipc.workspaceClose(id);
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
      const mru = w.mru.filter((x) => x !== tabId && tabs.some((t) => t.id === x));
      const activeTabId =
        w.activeTabId === tabId
          ? (mru[0] ?? (tabs[idx] ?? tabs[idx - 1])?.id ?? null)
          : w.activeTabId;
      return { ...w, tabs, activeTabId, mru };
    });
  };

  /**
   * Connects a disconnected workspace in place: on success its placeholder id becomes
   * the backend id (tabs, their ids, mru and preview flags are kept); on failure it is
   * disconnected again and the error goes to the caller (the connect flow prompts).
   */
  const connectInPlace = async (
    placeholderId: string,
    cfg: ConnectionConfig,
    password: string | null,
    sshSecret: string | null,
    acceptFingerprint: string | null,
  ) => {
    const status = (st: WorkspaceStatus) => update(placeholderId, (w) => ({ ...w, status: st }));
    status("connecting");
    let info: WorkspaceInfo;
    let schemas: string[];
    try {
      info = await ipc.workspaceOpen(cfg.id, password, sshSecret, acceptFingerprint);
    } catch (e) {
      status("disconnected");
      throw e;
    }
    /** The restored database that could not be selected again. */
    let unavailable: string | null = null;
    try {
      const wanted = get().workspaces.find((w) => w.id === placeholderId)?.database ?? null;
      // MySQL / SQLite carry the database in the schema; only PostgreSQL switches.
      if (info.capabilities.databaseSwitch && wanted && wanted !== info.database) {
        try {
          info = await ipc.workspaceSwitchDatabase(info.workspaceId, wanted);
        } catch {
          // Gone or refused: stay on the connection's default database (below: its
          // table tabs are closed and the user is told).
          unavailable = wanted;
        }
      }
      schemas = await ipc.schemasList(info.workspaceId);
    } catch (e) {
      void ipc.workspaceClose(info.workspaceId).catch(() => {});
      status("disconnected");
      throw e;
    }
    const newId = info.workspaceId;
    if (!get().workspaces.some((w) => w.id === placeholderId)) {
      // Closed by the user while connecting.
      void ipc.workspaceClose(newId).catch(() => {});
      return;
    }
    const counter = queryCounters.get(placeholderId);
    queryCounters.delete(placeholderId);
    if (counter !== undefined) queryCounters.set(newId, counter);
    const { dialect, capabilities } = info;
    const database = info.database;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === placeholderId
          ? {
              ...w,
              id: newId,
              dialect,
              capabilities,
              status: "connected",
              database,
              schemas,
              currentSchema:
                w.currentSchema !== null && schemas.includes(w.currentSchema)
                  ? w.currentSchema
                  : defaultSchema(dialect, schemas, cfg.database),
              ...(unavailable !== null && {
                notice: strings.session.databaseFallback(unavailable, database),
              }),
            }
          : w,
      ),
      activeWorkspaceId: s.activeWorkspaceId === placeholderId ? newId : s.activeWorkspaceId,
      connectRequest:
        s.connectRequest?.workspaceId === placeholderId ? null : s.connectRequest,
    }));
    if (unavailable !== null) {
      // Like a database switch: they would show the default database's tables under
      // the old titles. Query tabs stay (they open their own session).
      const stale = get().workspaces.find((w) => w.id === newId)?.tabs ?? [];
      for (const t of stale) {
        if (t.kind === "table") get().closeTab(newId, t.id);
      }
    }
  };

  return {
    workspaces: [],
    activeWorkspaceId: null,
    connectRequest: null,

    openWorkspace: async (
      connectionId,
      password = null,
      sshSecret = null,
      acceptFingerprint = null,
    ) => {
      const existing = get().workspaces.find((w) => w.connectionId === connectionId);
      if (existing) set({ activeWorkspaceId: existing.id });
      if (existing?.status === "connected") return;
      const inflight = opening.get(connectionId);
      if (inflight) return inflight;
      const cfg = useConnections.getState().items.find((c) => c.id === connectionId);
      if (!cfg) throw { kind: "notFound", message: strings.workspace.openFailed };
      const p = (
        existing
          ? connectInPlace(existing.id, cfg, password, sshSecret, acceptFingerprint)
          : doOpen(cfg, password, sshSecret, acceptFingerprint)
      ).finally(() => opening.delete(connectionId));
      opening.set(connectionId, p);
      return p;
    },

    isCommitting: (wsId, tabId) => {
      const committing = usePendingChanges.getState().committing;
      if (tabId !== undefined) return committing[tabId] === true;
      const tabs = get().workspaces.find((w) => w.id === wsId)?.tabs ?? [];
      return tabs.some((t) => committing[t.id] === true);
    },

    closeWorkspace: async (id) => {
      if (get().isCommitting(id)) return;
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

    setActiveWorkspace: (id) => {
      set({ activeWorkspaceId: id });
      get().requestConnect(id);
    },

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

    switchDatabase: async (wsId, database) => {
      if (switching.has(wsId)) return;
      // The switch closes the table tabs; one with pending changes would only ask to
      // discard them after the backend switched (and its commit would then write to the
      // same-named table of the new database). Refuse first, as the error the sidebar
      // and the palette already show.
      const pending = (get().workspaces.find((w) => w.id === wsId)?.tabs ?? [])
        .filter((t) => t.kind === "table")
        .reduce((n, t) => n + usePendingChanges.getState().count(t.id), 0);
      if (pending > 0) {
        throw { kind: "invalid", message: strings.workspace.switchDatabasePending(pending) };
      }
      switching.add(wsId);
      try {
        const info = await ipc.workspaceSwitchDatabase(wsId, database);
        const db = info.database ?? database;
        const stale = get().workspaces.find((w) => w.id === wsId)?.tabs ?? [];
        for (const t of stale) {
          if (t.kind === "table") get().closeTab(wsId, t.id);
        }
        update(wsId, (w) => ({ ...w, database: db }));
        let schemas: string[];
        try {
          schemas = await ipc.schemasList(wsId);
        } catch (e) {
          update(wsId, (w) => ({ ...w, schemas: [], currentSchema: null }));
          throw e;
        }
        update(wsId, (w) => ({
          ...w,
          schemas,
          currentSchema: defaultSchema(w.dialect, schemas, db),
        }));
      } finally {
        switching.delete(wsId);
      }
    },

    openQueryTab: (wsId, sql = "") =>
      update(wsId, (w) => {
        const n = (queryCounters.get(wsId) ?? 0) + 1;
        queryCounters.set(wsId, n);
        const tab: Tab = {
          id: crypto.randomUUID(),
          kind: "query",
          title: strings.workspace.queryTitle(n),
          sql,
          sqlSessionId: null,
        };
        return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id, mru: touch(w.mru, tab.id) };
      }),

    closeTab: (wsId, tabId) => {
      const tab = get().workspaces.find((w) => w.id === wsId)?.tabs.find((t) => t.id === tabId);
      if (!tab || get().isCommitting(wsId, tabId)) return;
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
      if (!req || get().isCommitting(req.wsId, req.tabId ?? undefined)) return;
      if (req.tabId !== null) doCloseTab(req.wsId, req.tabId);
      else await doCloseWorkspace(req.wsId);
    },

    cancelClose: () => set({ closeRequest: null }),

    activateTab: (wsId, tabId) => {
      update(wsId, (w) =>
        w.tabs.some((t) => t.id === tabId)
          ? { ...w, activeTabId: tabId, mru: touch(w.mru, tabId) }
          : w,
      );
      get().requestConnect(wsId);
    },

    updateTab: (wsId, tabId, patch) =>
      update(wsId, (w) => ({
        ...w,
        tabs: w.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, ...patch } : t)),
      })),

    dismissNotice: (wsId) => update(wsId, (w) => ({ ...w, notice: null })),

    restoreWorkspaces: (list, activeId) => {
      const open = new Set(get().workspaces.map((w) => w.connectionId));
      const added: Workspace[] = [];
      for (const w of list) {
        if (open.has(w.connectionId)) continue;
        open.add(w.connectionId);
        added.push(w);
        queryCounters.set(w.id, lastQueryNumber(w.tabs));
      }
      set((s) => ({
        workspaces: [...s.workspaces, ...added],
        activeWorkspaceId:
          s.activeWorkspaceId ??
          (added.some((w) => w.id === activeId) ? activeId : (added[0]?.id ?? null)),
      }));
    },

    requestConnect: (wsId) => {
      if (get().workspaces.find((w) => w.id === wsId)?.status === "disconnected") {
        set({ connectRequest: { workspaceId: wsId } });
      }
    },

    clearConnectRequest: () => set({ connectRequest: null }),

    openSavedQueryTab: (wsId, name, sql) =>
      update(wsId, (w) => {
        const linked = w.tabs.find((t) => t.kind === "query" && t.savedName === name);
        if (linked) return { ...w, activeTabId: linked.id, mru: touch(w.mru, linked.id) };
        const tab: Tab = {
          id: crypto.randomUUID(),
          kind: "query",
          title: name,
          sql,
          sqlSessionId: null,
          savedName: name,
          savedSql: sql,
        };
        return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id, mru: touch(w.mru, tab.id) };
      }),

    sidebarVisible: true,
    toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  };
});

// A preview tab is pinned by the first change the user makes in it (Plan 4, ruling R1), so
// a single click in the sidebar never replaces it: a sort, page or filter change and a
// foreign key navigation (its grid view and trail) here, a pending edit below. The page
// size the grid latches into the view when it mounts (Plan 5 settings) is not a user change.
const userView = (v: GridView | undefined) =>
  JSON.stringify([v?.page ?? 0, v?.sort ?? null, v?.filters ?? []]);
useGridViews.subscribe((state, prev) => {
  for (const tabId of Object.keys(state.views)) {
    const navigated = state.trails[tabId] !== prev.trails[tabId];
    if (!navigated && userView(state.views[tabId]) === userView(prev.views[tabId])) continue;
    for (const w of useWorkspaces.getState().workspaces) {
      if (w.tabs.some((t) => t.id === tabId && t.kind === "table" && t.preview)) {
        useWorkspaces.getState().pinTab(w.id, tabId);
      }
    }
  }
});

usePendingChanges.subscribe((state, prev) => {
  for (const tabId of Object.keys(state.tabs)) {
    if (state.tabs[tabId] === prev.tabs[tabId] || usePendingChanges.getState().count(tabId) === 0) {
      continue;
    }
    for (const w of useWorkspaces.getState().workspaces) {
      if (w.tabs.some((t) => t.id === tabId && t.kind === "table" && t.preview)) {
        useWorkspaces.getState().pinTab(w.id, tabId);
      }
    }
  }
});
