/**
 * Session restore: the open workspaces and their tabs survive a restart.
 *
 * The snapshot holds no secret, no SQL session, no transaction and no connection: a
 * restored workspace comes back `disconnected` and connects when the user activates it
 * (the connect flow asks for the secrets as usual). A session file that cannot be read
 * (invalid JSON, unknown version, bad shape) is ignored, and is not overwritten before
 * the user changes something.
 */
import { toAppError } from "../lib/errors";
import * as ipc from "../lib/ipc";
import { flushPending } from "../lib/pendingFlush";
import { onFlushRequested } from "../lib/windowClose";
import type { Dialect, DriverKind, ObjectRef } from "../lib/types";
import { useConnections } from "./connections";
import { type Tab, type Workspace, useWorkspaces } from "./workspaces";

export type SessionTab =
  /** `title` (optional, Task 4): the name the user gave the tab, when not the table's. */
  | { kind: "table"; object: ObjectRef; preview: boolean; title?: string }
  /**
   * `savedName` (optional, Plan 4 Task 8): the saved query the tab is linked to.
   * `database` (optional, Plan 4 review): the database its SQL session was opened on.
   * The SQL text is kept as typed: it is the user's own unsaved document, like a file.
   */
  | { kind: "query"; title: string; sql: string; savedName?: string; database?: string };

export interface SessionWorkspace {
  connectionId: string;
  currentSchema: string | null;
  database: string | null;
  activeTabIndex: number | null;
  tabs: SessionTab[];
}

export interface SessionSnapshot {
  version: 1;
  activeWorkspaceIndex: number | null;
  workspaces: SessionWorkspace[];
}

/** Debounce between the last store change and the write. */
export const SESSION_SAVE_DELAY_MS = 1000;

/** Prefix of the frontend ids of restored workspaces, replaced by the backend id on connect. */
export const RESTORED_ID_PREFIX = "restored:";

/** The persisted view of the store. Fields are picked one by one: nothing else leaks in. */
export function snapshot(state: {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}): SessionSnapshot {
  const index = (i: number) => (i < 0 ? null : i);
  return {
    version: 1,
    activeWorkspaceIndex: index(state.workspaces.findIndex((w) => w.id === state.activeWorkspaceId)),
    workspaces: state.workspaces.map((w) => ({
      connectionId: w.connectionId,
      currentSchema: w.currentSchema,
      database: w.database,
      activeTabIndex: index(w.tabs.findIndex((t) => t.id === w.activeTabId)),
      tabs: w.tabs.map(
        (t): SessionTab =>
          t.kind === "table"
            ? {
                kind: "table",
                object: { schema: t.object.schema, name: t.object.name },
                preview: t.preview,
                ...(t.title !== t.object.name ? { title: t.title } : {}),
              }
            : {
                kind: "query",
                title: t.title,
                sql: t.sql,
                ...(t.savedName ? { savedName: t.savedName } : {}),
                ...(t.database ? { database: t.database } : {}),
              },
      ),
    })),
  };
}

// ---- Validation: required fields must be there with the right type; extra ones are
// ignored (forward compatible within version 1) and dropped from the result. A tab of a
// kind this version does not know (added later) is skipped, not fatal. ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isIndex = (v: unknown, len: number): v is number | null =>
  v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < len);

/** Tab kinds this version restores; another string kind is skipped. */
const KNOWN_TAB_KINDS = ["table", "query"];

function parseTab(v: unknown): SessionTab | null {
  if (!isObj(v)) return null;
  if (v.kind === "table") {
    const o = v.object;
    if (!isObj(o) || !isStrOrNull(o.schema) || typeof o.name !== "string") return null;
    if (typeof v.preview !== "boolean") return null;
    if (v.title !== undefined && typeof v.title !== "string") return null;
    return {
      kind: "table",
      object: { schema: o.schema, name: o.name },
      preview: v.preview,
      ...(typeof v.title === "string" ? { title: v.title } : {}),
    };
  }
  if (v.kind === "query") {
    if (typeof v.title !== "string" || typeof v.sql !== "string") return null;
    const optional = (x: unknown) => x === undefined || typeof x === "string";
    if (!optional(v.savedName) || !optional(v.database)) return null;
    return {
      kind: "query",
      title: v.title,
      sql: v.sql,
      ...(typeof v.savedName === "string" ? { savedName: v.savedName } : {}),
      ...(typeof v.database === "string" ? { database: v.database } : {}),
    };
  }
  return null;
}

function parseWorkspace(v: unknown): SessionWorkspace | null {
  if (!isObj(v) || typeof v.connectionId !== "string") return null;
  if (!isStrOrNull(v.currentSchema) || !isStrOrNull(v.database) || !Array.isArray(v.tabs)) return null;
  if (!isIndex(v.activeTabIndex, v.tabs.length)) return null;
  const tabs: SessionTab[] = [];
  let activeTabIndex: number | null = null;
  for (const [i, t] of v.tabs.entries()) {
    if (isObj(t) && typeof t.kind === "string" && !KNOWN_TAB_KINDS.includes(t.kind)) continue;
    const tab = parseTab(t);
    if (!tab) return null;
    if (i === v.activeTabIndex) activeTabIndex = tabs.length;
    tabs.push(tab);
  }
  return {
    connectionId: v.connectionId,
    currentSchema: v.currentSchema,
    database: v.database,
    activeTabIndex,
    tabs,
  };
}

/** The snapshot in `json`, or null for invalid JSON, an unknown version or a bad shape. */
export function parseSnapshot(json: string): SessionSnapshot | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.workspaces)) return null;
  const workspaces: SessionWorkspace[] = [];
  for (const w of v.workspaces) {
    const ws = parseWorkspace(w);
    if (!ws) return null;
    workspaces.push(ws);
  }
  if (!isIndex(v.activeWorkspaceIndex, workspaces.length)) return null;
  return { version: 1, activeWorkspaceIndex: v.activeWorkspaceIndex, workspaces };
}

/** No dialect for a document connection (MongoDB). */
const dialectOf = (kind: DriverKind): Dialect | null =>
  kind === "mongoDb" ? null : kind === "mariaDb" ? "mySql" : kind;

/** Disconnected workspaces for `snap`; connections deleted since are dropped. */
function restoredWorkspaces(snap: SessionSnapshot): { workspaces: Workspace[]; activeId: string | null } {
  const items = useConnections.getState().items;
  let activeId: string | null = null;
  const workspaces: Workspace[] = [];
  snap.workspaces.forEach((sw, i) => {
    const cfg = items.find((c) => c.id === sw.connectionId);
    if (!cfg) return;
    const tabs = sw.tabs.map(
      (t): Tab =>
        t.kind === "table"
          ? {
              id: crypto.randomUUID(),
              kind: "table",
              object: t.object,
              title: t.title?.trim() ? t.title : t.object.name,
              preview: t.preview,
            }
          : {
              id: crypto.randomUUID(),
              kind: "query",
              title: t.title,
              sql: t.sql,
              sqlSessionId: null,
              ...(t.savedName
                ? {
                    savedName: t.savedName,
                    // Unknown until the file is read (`hydrateSavedLinks`): no "modified" dot yet.
                    savedSql: undefined,
                  }
                : {}),
              ...(t.database ? { database: t.database } : {}),
            },
    );
    const active = sw.activeTabIndex === null ? null : tabs[sw.activeTabIndex];
    const ws: Workspace = {
      id: `${RESTORED_ID_PREFIX}${crypto.randomUUID()}`,
      connectionId: cfg.id,
      name: cfg.name,
      color: cfg.color,
      envTag: cfg.envTag,
      dialect: dialectOf(cfg.kind),
      status: "disconnected",
      database: sw.database,
      // Until it connects, only the saved schema is known (the sidebar is not shown).
      schemas: sw.currentSchema === null ? [] : [sw.currentSchema],
      currentSchema: sw.currentSchema,
      tabs,
      activeTabId: active?.id ?? null,
      mru: active ? [active.id, ...tabs.filter((t) => t !== active).map((t) => t.id)] : tabs.map((t) => t.id),
    };
    if (i === snap.activeWorkspaceIndex) activeId = ws.id;
    workspaces.push(ws);
  });
  return { workspaces, activeId };
}

/**
 * Restored tabs linked to a saved query: reads each file (no connection needed) so the
 * "modified" dot compares with what is on disk. A file deleted meanwhile unlinks the
 * tab (its text stays); another failure leaves the state unknown (no dot).
 */
async function hydrateSavedLinks(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const w of useWorkspaces.getState().workspaces) {
    for (const t of w.tabs) {
      if (t.kind !== "query" || !t.savedName || t.savedSql !== undefined) continue;
      const { id: tabId, savedName: name } = t;
      const connectionId = w.connectionId;
      const apply = (patch: { savedName?: string | null; savedSql: string | null }) => {
        // The workspace id changes when it connects: find the tab by its own id.
        const st = useWorkspaces.getState();
        const ws = st.workspaces.find((x) => x.tabs.some((y) => y.id === tabId));
        const cur = ws?.tabs.find((y) => y.id === tabId);
        if (ws && cur?.kind === "query" && cur.savedName === name) st.updateTab(ws.id, tabId, patch);
      };
      jobs.push(
        (async () => {
          try {
            const sql = await ipc.savedQueryRead(connectionId, name);
            if (typeof sql === "string") apply({ savedSql: sql });
          } catch (e) {
            if (toAppError(e).kind === "notFound") apply({ savedName: null, savedSql: null });
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
}

/** False until the initial restore is over: nothing is saved before. */
let ready = false;
/** JSON of the last snapshot saved, or read at restore: an equal one is not rewritten. */
let lastJson: string | null = null;

const currentJson = () => JSON.stringify(snapshot(useWorkspaces.getState()));

/**
 * At startup, after the connections are loaded: reads the stored session and recreates
 * its workspaces, disconnected, with their tabs. Never connects anything. An unreadable
 * session starts empty and is left on disk as is until the user changes something.
 */
export async function restoreSession(): Promise<void> {
  ready = false;
  try {
    let text: string | null = null;
    try {
      text = await ipc.sessionLoad();
    } catch {
      // Unreadable: start empty.
    }
    const snap = text === null ? null : parseSnapshot(text);
    if (snap) {
      const { workspaces, activeId } = restoredWorkspaces(snap);
      useWorkspaces.getState().restoreWorkspaces(workspaces, activeId);
    }
  } finally {
    // The restored state is the baseline: only a later change is written.
    lastJson = currentJson();
    ready = true;
  }
  void hydrateSavedLinks();
}

/**
 * Saves the session 1 s after the last change of the workspaces store, and at once when
 * the window is about to close: the backend holds the close back and sends an event
 * (`beforeunload` does not reliably run in the webview), the pending editor text is
 * pushed into the store, the session is written and awaited, then the close is
 * confirmed, whatever the outcome of the write. `beforeunload` stays as a harmless
 * extra (browser mode). Nothing is saved before `restoreSession` finished, nor when the
 * snapshot equals the last one saved or restored (a status or id change alone).
 * Returns the function that stops it.
 */
export function startSessionAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The write in flight, so a close waits for it too. */
  let inflight: Promise<void> | null = null;

  const save = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!ready) return Promise.resolve();
    const json = currentJson();
    if (json === lastJson) return Promise.resolve();
    lastJson = json;
    const write = ipc
      .sessionSave(json)
      .catch(() => {
        // Too large or not writable: try again on the next change.
        if (lastJson === json) lastJson = null;
      })
      .finally(() => {
        if (inflight === write) inflight = null;
      });
    inflight = write;
    return write;
  };

  const unsubscribe = useWorkspaces.subscribe((s, prev) => {
    if (!ready) return;
    if (s.workspaces === prev.workspaces && s.activeWorkspaceId === prev.activeWorkspaceId) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SESSION_SAVE_DELAY_MS);
  });

  const onUnload = () => {
    if (timer) void save();
  };
  window.addEventListener("beforeunload", onUnload);

  let stopped = false;
  const onFlush = async () => {
    try {
      flushPending();
      await save();
      if (inflight) await inflight;
    } catch {
      // Closing matters more than the save.
    } finally {
      try {
        await ipc.windowCloseConfirmed();
      } catch {
        // The backend closes on its own after its fallback delay.
      }
    }
  };
  let unlisten: (() => void) | null = null;
  void onFlushRequested(() => void onFlush()).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });

  return () => {
    stopped = true;
    unlisten?.();
    unsubscribe();
    window.removeEventListener("beforeunload", onUnload);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
