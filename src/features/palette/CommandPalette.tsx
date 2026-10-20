import { Command } from "cmdk";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { effectiveShortcut, isKeymapActionId, useAction } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { isModalOpen } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";
import { catalogKey, useCatalog } from "../../stores/catalog";
import { useChrome, useOnRequest } from "../../stores/chrome";
import { useConnections } from "../../stores/connections";
import { useSettings } from "../../stores/settings";
import { capabilitiesOf, useWorkspaces } from "../../stores/workspaces";
import { focusActiveTab } from "../workspace/focusActiveTab";
import { tabKindLabel } from "../workspace/tabInfo";
import { type ActionCtx, visibleActions } from "./actions";
import { fuzzyScore, rank } from "./fuzzy";


/** At most this many items are rendered per group (a 5 000-table schema stays fluid). */
export const MAX_PER_GROUP = 200;

/** A query starting with it lists the actions (Open Anything, spec §5.5); the placeholder (strings.ts) names it. */
export const ACTION_PREFIX = ">";

type Mode = "all";
type Sub = "schema" | "database" | null;

interface Props {
  /** Opens a saved connection through App's connect flow (prompts included). */
  onOpenConnection: (cfg: ConnectionConfig) => void;
  /** Shows the new-connection form. */
  onNewConnection: () => void;
  /** Shows the connection list (as Ctrl+Shift+K). */
  onShowConnections: () => void;
  /** Called after the palette activates something of the workspace, so App shows it. */
  onShowWorkspace: () => void;
}

// Rows of 40 px (spec §2.3, Open Anything).
const itemClass =
  "flex h-10 cursor-pointer items-center justify-between gap-3 rounded-sm px-2 data-[selected=true]:bg-accent data-[selected=true]:text-accent-contrast";
const headingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:text-muted";

export function CommandPalette({ onOpenConnection, onNewConnection, onShowConnections, onShowWorkspace }: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");
  const [sub, setSub] = useState<Sub>(null);
  const [subError, setSubError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[] | null>(null);
  const returnFocus = useRef<Element | null>(null);
  /** The query a sub-list gives back on Escape: the actions when it was opened from them. */
  const subReturn = useRef("");

  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeWorkspaceId);
  const connections = useConnections((s) => s.items);
  const keymap = useSettings((s) => s.settings.keymap);
  const workspace = workspaces.find((w) => w.id === activeId) ?? null;
  const connected = workspace?.status === "connected";
  const schema = workspace?.currentSchema ?? null;
  const wsId = workspace?.id ?? null;
  const key = wsId && schema !== null ? catalogKey(wsId, schema) : null;
  const entry = useCatalog((s) => (wsId ? s.catalogs[wsId]?.[schema ?? ""] : undefined));
  const catalogError = useCatalog((s) => (key ? (s.errors[key] ?? null) : null));
  const catalogLoading = useCatalog((s) => (key ? s.loading[key] === true : false));
  const open = mode !== null;

  const openPalette = (m: Mode) => {
    returnFocus.current = document.activeElement;
    setQuery("");
    setSub(null);
    setSubError(null);
    setMode(m);
  };
  const close = () => {
    setMode(null);
    setSub(null);
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el instanceof HTMLElement) el.focus();
  };
  /**
   * Closes, runs the action (palette still mounted, so an action may focus its own
   * target), then gives focus back to the opener only if nothing else holds it and the
   * opener still exists: a tab or object the action opened keeps its own focus.
   */
  const closeAfter = (fn: () => void) => {
    const el = returnFocus.current;
    returnFocus.current = null;
    setMode(null);
    setSub(null);
    fn();
    setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
      else focusActiveTab();
    }, 0);
  };
  const toggle = (m: Mode) => {
    if (mode === null) {
      if (!isModalOpen()) openPalette(m);
    } else if (mode === m) close();
    else {
      setMode(m);
      setSub(null);
      setQuery("");
    }
  };
  // The palette is itself aria-modal, so its own chords must work while it is open.
  useAction("palette.all", () => toggle("all"), { allowInModal: true });
  // Mod+K: straight to the database list (PostgreSQL), else the schema list.
  useAction("database.open", () => openPicker(), { allowInModal: true });
  // The toolbar's Open anything and database buttons.
  const request = useChrome((s) => s.paletteRequest);
  useOnRequest(request?.seq ?? 0, () => {
    if (request?.kind === "database") openPicker();
    else if (mode === null) toggle("all");
  });

  // The catalog loads once per (workspace, schema); only a connected workspace has one.
  useEffect(() => {
    if (open && connected && wsId && schema !== null) void useCatalog.getState().ensureCatalog(wsId, schema);
  }, [open, connected, wsId, schema]);

  const enterSub = (s: Exclude<Sub, null>, back = "") => {
    subReturn.current = back;
    setSub(s);
    setQuery("");
    setSubError(null);
    if (s === "database" && workspace) {
      setDatabases(null);
      ipc.databasesList(workspace.id).then(setDatabases, (e) => setSubError(toAppError(e).message));
    }
  };
  /** Opens the palette on the database (or schema) list of a connected workspace. */
  const openPicker = () => {
    if (!workspace || !connected) return;
    const target: Exclude<Sub, null> | null = capabilitiesOf(workspace).databaseSwitch
      ? "database"
      : workspace.schemas.length > 0
        ? "schema"
        : null;
    if (!target) return;
    if (mode === null) {
      if (isModalOpen()) return;
      returnFocus.current = document.activeElement;
      setMode("all");
    } else if (sub === target) {
      close();
      return;
    }
    enterSub(target);
  };
  const back = () => {
    setSub(null);
    setQuery(subReturn.current);
    setSubError(null);
  };

  const ctx: ActionCtx = {
    workspace,
    tab: workspace?.tabs.find((t) => t.id === workspace.activeTabId) ?? null,
    newConnection: onNewConnection,
    showConnections: onShowConnections,
    pickSchema: () => enterSub("schema"),
    pickDatabase: () => enterSub("database"),
  };
  // Open Anything: objects (tables, tabs, connections) by default, the actions after ">".
  const actionMode = !sub && query.startsWith(ACTION_PREFIX);
  const actionQuery = query.slice(ACTION_PREFIX.length).trim();

  const tables = connected ? (entry?.catalog.tables ?? null) : null;
  const objects = useMemo(
    () => rank(actionMode ? [] : (tables ?? []), query, (t) => t.name, MAX_PER_GROUP),
    [tables, query, actionMode],
  );
  const tabs = useMemo(
    () => rank(workspace?.tabs ?? [], query, (t) => t.title, MAX_PER_GROUP),
    [workspace?.tabs, query],
  );
  const conns = useMemo(
    () => rank(connections, query, (c) => c.name, MAX_PER_GROUP),
    [connections, query],
  );
  const actions = actionMode ? visibleActions(ctx).filter((a) => fuzzyScore(actionQuery, a.title) > 0) : [];
  const schemaItems = useMemo(
    () => rank(workspace?.schemas ?? [], query, (n) => n, MAX_PER_GROUP),
    [workspace?.schemas, query],
  );
  const dbItems = useMemo(() => rank(databases ?? [], query, (n) => n, MAX_PER_GROUP), [databases, query]);

  if (!open) return null;

  const run = (fn: () => void) => () => closeAfter(fn);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (sub) back();
      else close();
    } else if (e.key === "Backspace" && sub && query === "") {
      e.preventDefault();
      back();
    }
  };

  const objectsGroup = (
    <Command.Group heading={strings.palette.objects} className={headingClass}>
      {objects.items.map((t) => (
        <Command.Item
          key={t.name}
          value={`object:${t.name}`}
          className={itemClass}
          onSelect={run(() => {
            if (!workspace || schema === null) return;
            useWorkspaces.getState().openTableTab(workspace.id, { schema, name: t.name }, { preview: true });
            onShowWorkspace();
          })}
        >
          <span>{t.name}</span>
          <span className="text-sm opacity-70">
            {t.kind === "view" ? strings.sidebar.kinds.view : strings.sidebar.kinds.table}
          </span>
        </Command.Item>
      ))}
      {objects.total > objects.items.length && (
        <p className="px-2 py-1 text-sm text-muted">
          {strings.palette.truncated(objects.items.length, objects.total)}
        </p>
      )}
      {catalogError && (
        <p role="alert" className="px-2 py-1 text-danger">
          {`${strings.palette.loadFailed}: ${catalogError}`}
        </p>
      )}
      {catalogLoading && !tables && <p className="px-2 py-1 text-muted">{strings.palette.loading}</p>}
    </Command.Group>
  );

  let body: ReactNode;
  let empty = false;
  if (sub) {
    const list = sub === "schema" ? schemaItems : dbItems;
    const current = sub === "schema" ? schema : (workspace?.database ?? null);
    empty = list.items.length === 0 && (sub === "schema" || databases !== null);
    body = (
      <Command.Group heading={sub === "schema" ? strings.palette.action.changeSchema : strings.palette.action.changeDatabase} className={headingClass}>
        {list.items.map((name) => (
          <Command.Item
            key={name}
            value={`${sub}:${name}`}
            className={itemClass}
            onSelect={() => {
              if (!workspace) return;
              if (sub === "schema") {
                closeAfter(() => useWorkspaces.getState().setSchema(workspace.id, name));
              } else {
                setSubError(null);
                useWorkspaces
                  .getState()
                  .switchDatabase(workspace.id, name)
                  .then(close, (e) => setSubError(`${strings.palette.switchFailed}: ${toAppError(e).message}`));
              }
            }}
          >
            <span>{name}</span>
            {name === current && <span aria-hidden="true">✓</span>}
          </Command.Item>
        ))}
        {sub === "database" && databases === null && !subError && (
          <p className="px-2 py-1 text-muted">{strings.palette.loading}</p>
        )}
      </Command.Group>
    );
  } else {
    const showTabs = !actionMode && tabs.items.length > 0;
    const showConns = !actionMode && conns.items.length > 0;
    const showActions = actions.length > 0;
    const showObjects =
      !actionMode && (objects.items.length > 0 || catalogError !== null || (catalogLoading && !tables));
    empty = !showObjects && !showTabs && !showConns && !showActions;
    body = (
      <>
        {showObjects && objectsGroup}
        {showTabs && (
          <Command.Group heading={strings.palette.tabs} className={headingClass}>
            {tabs.items.map((t) => (
              <Command.Item
                key={t.id}
                value={`tab:${t.id}`}
                className={itemClass}
                onSelect={run(() => {
                  if (!workspace) return;
                  useWorkspaces.getState().activateTab(workspace.id, t.id);
                  onShowWorkspace();
                })}
              >
                <span>{t.title}</span>
                <span className="text-sm opacity-70">{tabKindLabel(t)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {showConns && (
          <Command.Group heading={strings.palette.connections} className={headingClass}>
            {conns.items.map((c) => (
              <Command.Item
                key={c.id}
                value={`connection:${c.id}`}
                className={itemClass}
                onSelect={run(() => onOpenConnection(c))}
              >
                <span>{c.name}</span>
                <span className="text-sm opacity-70">{strings.env[c.envTag]}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {showActions && (
          <Command.Group heading={strings.palette.actions} className={headingClass}>
            {actions.map((a) => (
              <Command.Item
                key={a.id}
                value={`action:${a.id}`}
                className={itemClass}
                onSelect={() => {
                  const c: ActionCtx = {
                    ...ctx,
                    pickSchema: () => {
                      enterSub("schema", ACTION_PREFIX);
                    },
                    pickDatabase: () => {
                      enterSub("database", ACTION_PREFIX);
                    },
                  };
                  if (a.id === "schema.change" || a.id === "database.change") {
                    // Opens a sub-list: the palette stays.
                    a.run(c);
                  } else {
                    closeAfter(() => a.run(c));
                  }
                }}
              >
                <span>{a.title}</span>
                {isKeymapActionId(a.id) && (
                  <kbd className="font-mono text-sm opacity-70">
                    {formatShortcut(effectiveShortcut(a.id, keymap))}
                  </kbd>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </>
    );
  }

  const placeholder = sub
    ? sub === "schema"
      ? strings.palette.schemaPlaceholder
      : strings.palette.databasePlaceholder
    : strings.palette.placeholder;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={strings.palette.label}
        onKeyDown={onKeyDown}
        className="w-[36rem] max-w-[90vw] overflow-hidden rounded-sm border border-border bg-surface shadow-lg"
      >
        <Command shouldFilter={false} label={strings.palette.label}>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder}
            aria-label={strings.palette.inputLabel}
            className="w-full border-b border-border bg-surface px-3 py-2 outline-none"
          />
          <Command.List className="max-h-[50vh] overflow-y-auto p-1">
            {body}
            {empty && !subError && <p className="px-2 py-3 text-muted">{strings.palette.empty}</p>}
            {subError && (
              <p role="alert" className="px-2 py-1 text-danger">
                {subError}
              </p>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
