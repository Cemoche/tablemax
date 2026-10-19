import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { qualifiedName } from "../../lib/sqlIdent";
import { strings } from "../../lib/strings";
import type { DbObject, DbRoutine } from "../../lib/types";
import { useCatalog } from "../../stores/catalog";
import { useChrome, useOnRequest } from "../../stores/chrome";
import { type Workspace, capabilitiesOf, sqlDialect, useWorkspaces } from "../../stores/workspaces";

type Entry =
  | { type: "object"; object: DbObject }
  | { type: "routine"; routine: DbRoutine };

interface MenuState {
  entry: Entry;
  x: number;
  y: number;
}

const entryName = (e: Entry) => (e.type === "object" ? e.object.name : e.routine.name);

export function ObjectSidebar({ workspace }: { workspace: Workspace }) {
  const setSchema = useWorkspaces((s) => s.setSchema);
  const openTableTab = useWorkspaces((s) => s.openTableTab);
  const openQueryTab = useWorkspaces((s) => s.openQueryTab);
  const switchDatabase = useWorkspaces((s) => s.switchDatabase);
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [routines, setRoutines] = useState<DbRoutine[]>([]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { id, currentSchema, status, database } = workspace;
  const { databaseSwitch, routines: hasRoutines, sqlEditor } = capabilitiesOf(workspace);
  // The toolbar's Reload (Mod+R) reloads the lists like Refresh; it rebuilds the catalog itself.
  useOnRequest(
    useChrome((s) => s.reloads[id] ?? 0),
    () => setReload((n) => n + 1),
  );

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    ipc
      .objectsList(id, currentSchema)
      .then((list) => {
        if (!stale) setObjects(list);
      })
      .catch((e) => {
        if (!stale) {
          setObjects([]);
          setError(toAppError(e).message);
        }
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [id, currentSchema, database, reload]);

  useEffect(() => {
    if (!hasRoutines) return;
    let stale = false;
    ipc
      .routinesList(id, currentSchema)
      .then((list) => {
        if (!stale) setRoutines(list);
      })
      .catch(() => {
        if (!stale) setRoutines([]);
      });
    return () => {
      stale = true;
    };
  }, [id, hasRoutines, currentSchema, database, reload]);

  useEffect(() => {
    if (!databaseSwitch || status !== "connected") return;
    let stale = false;
    ipc
      .databasesList(id)
      .then((list) => {
        if (!stale) setDatabases(list);
      })
      .catch(() => {
        if (!stale) setDatabases([]);
      });
    return () => {
      stale = true;
    };
  }, [id, databaseSwitch, status, reload]);

  // Escape closes the menu; so does any outside click.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onDown = (e: globalThis.MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('[role="menu"]')) setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  const { tables, views, shownRoutines } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const keep = <T extends { name: string }>(l: T[]) =>
      q ? l.filter((o) => o.name.toLowerCase().includes(q)) : l;
    const objs = keep(objects);
    return {
      tables: objs.filter((o) => o.kind === "table"),
      views: objs.filter((o) => o.kind === "view"),
      shownRoutines: keep(routines),
    };
  }, [objects, routines, query]);

  const refresh = () => {
    setReload((n) => n + 1);
    // Rebuild the catalog (backend cache and palette store); never blocks the UI.
    void useCatalog.getState().refreshCatalog(id, currentSchema);
  };

  const changeDatabase = async (name: string) => {
    setSwitchError(null);
    setSwitching(true);
    try {
      await switchDatabase(id, name);
    } catch (e) {
      setSwitchError(`${strings.sidebar.switchFailed}: ${toAppError(e).message}`);
    } finally {
      setSwitching(false);
    }
  };

  const openMenuAt = (entry: Entry, x: number, y: number) => setMenu({ entry, x, y });
  const onContext = (entry: Entry) => (e: MouseEvent) => {
    e.preventDefault();
    openMenuAt(entry, e.clientX, e.clientY);
  };
  const onItemKey = (entry: Entry) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      openMenuAt(entry, r.left, r.bottom);
    }
  };

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  const objectItem = (o: DbObject) => {
    const entry: Entry = { type: "object", object: o };
    const isTable = o.kind === "table";
    return (
      <li key={`${o.kind}:${o.name}`}>
        <button
          type="button"
          onClick={() => openTableTab(id, { schema: o.schema, name: o.name }, { preview: true })}
          onDoubleClick={() => openTableTab(id, { schema: o.schema, name: o.name })}
          onContextMenu={onContext(entry)}
          onKeyDown={onItemKey(entry)}
          className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-surface-2"
        >
          <span
            aria-label={isTable ? strings.sidebar.table : strings.sidebar.view}
            role="img"
            className={isTable ? "text-accent" : "text-muted"}
          >
            {isTable ? strings.sidebar.tableIcon : strings.sidebar.viewIcon}
          </span>
          <span className="truncate">{o.name}</span>
        </button>
      </li>
    );
  };

  const routineItem = (r: DbRoutine) => {
    const entry: Entry = { type: "routine", routine: r };
    return (
      <li key={`${r.kind}:${r.name}`}>
        <button
          type="button"
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            openMenuAt(entry, b.left, b.bottom);
          }}
          onContextMenu={onContext(entry)}
          onKeyDown={onItemKey(entry)}
          className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-surface-2"
        >
          <span
            aria-label={r.kind === "function" ? strings.sidebar.function : strings.sidebar.procedure}
            role="img"
            className="text-muted"
          >
            {r.kind === "function" ? strings.sidebar.functionIcon : strings.sidebar.procedureIcon}
          </span>
          <span className="truncate">{r.name}</span>
        </button>
      </li>
    );
  };

  const section = (key: string, label: string, count: number, items: React.ReactNode) => (
    <section key={key}>
      <button
        type="button"
        aria-expanded={!collapsed[key]}
        onClick={() => toggle(key)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-muted hover:bg-surface-2"
      >
        <span aria-hidden="true">{collapsed[key] ? "▸" : "▾"}</span>
        <span>{label}</span>
        <span aria-hidden="true" className="ml-auto">
          {count}
        </span>
      </button>
      {!collapsed[key] && <ul>{items}</ul>}
    </section>
  );

  const nothing = objects.length === 0 && routines.length === 0;
  const nothingShown = tables.length + views.length + shownRoutines.length === 0;

  return (
    <aside
      aria-label={strings.sidebar.label}
      className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="flex flex-col gap-2 border-b border-border p-2">
        {databaseSwitch && (
          <select
            aria-label={strings.sidebar.database}
            value={database ?? ""}
            disabled={switching}
            onChange={(e) => void changeDatabase(e.target.value)}
            className="rounded-sm border border-border bg-bg px-2 py-1"
          >
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        {switchError && <p className="text-danger">{switchError}</p>}
        <div className="flex gap-2">
          <select
            aria-label={strings.sidebar.schema}
            value={currentSchema ?? ""}
            disabled={switching}
            onChange={(e) => setSchema(id, e.target.value)}
            className="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1"
          >
            {workspace.schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={refresh}
            disabled={switching}
            className="rounded-sm border border-border bg-bg px-2 py-1 hover:bg-surface-2"
          >
            {strings.sidebar.refresh}
          </button>
        </div>
        <input
          type="search"
          aria-label={strings.sidebar.filter}
          placeholder={strings.sidebar.filter}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="rounded-sm border border-border bg-bg px-2 py-1"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {error && <p className="p-2 text-danger">{error}</p>}
        {loading && <p className="p-2 text-muted">{strings.sidebar.loading}</p>}
        {!loading && !error && nothingShown && (
          <p className="p-2 text-muted">
            {nothing ? strings.sidebar.empty : strings.sidebar.noMatch}
          </p>
        )}
        {section("tables", strings.sidebar.tables, tables.length, tables.map(objectItem))}
        {section("views", strings.sidebar.views, views.length, views.map(objectItem))}
        {hasRoutines &&
          section("routines", strings.sidebar.routines, shownRoutines.length, shownRoutines.map(routineItem))}
      </div>
      {menu && (
        <ObjectMenu
          menu={menu}
          onClose={() => setMenu(null)}
          sqlEditor={sqlEditor}
          actions={{
            open: () => {
              if (menu.entry.type === "object") {
                const o = menu.entry.object;
                openTableTab(id, { schema: o.schema, name: o.name }, { preview: true });
              }
            },
            openNewTab: () => {
              if (menu.entry.type === "object") {
                const o = menu.entry.object;
                openTableTab(id, { schema: o.schema, name: o.name });
              }
            },
            newQuery: () => {
              if (menu.entry.type === "object") {
                const o = menu.entry.object;
                openQueryTab(
                  id,
                  `SELECT * FROM ${qualifiedName(sqlDialect(workspace), o.schema, o.name)} LIMIT 100;`,
                );
              }
            },
            copyName: () => {
              void navigator.clipboard?.writeText(entryName(menu.entry))?.catch(() => {});
            },
          }}
        />
      )}
    </aside>
  );
}

function ObjectMenu({
  menu,
  onClose,
  sqlEditor,
  actions,
}: {
  menu: MenuState;
  onClose: () => void;
  /** Offer "New query" (a SQL tab on the object). */
  sqlEditor: boolean;
  actions: { open: () => void; openNewTab: () => void; newQuery: () => void; copyName: () => void };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isObject = menu.entry.type === "object";
  const items: [string, () => void][] = [
    ...(isObject
      ? ([
          [strings.sidebar.menu.open, actions.open],
          [strings.sidebar.menu.openNewTab, actions.openNewTab],
          ...(sqlEditor ? [[strings.sidebar.menu.newQuery, actions.newQuery]] : []),
        ] as [string, () => void][])
      : []),
    [strings.sidebar.menu.copyName, actions.copyName],
  ];

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") els[(i + 1) % els.length]?.focus();
    else if (e.key === "ArrowUp") els[(i - 1 + els.length) % els.length]?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={strings.sidebar.menuLabel}
      onKeyDown={onKeyDown}
      style={{ left: menu.x, top: menu.y }}
      className="fixed z-50 flex min-w-40 flex-col rounded-sm border border-border bg-surface py-1 shadow-lg"
    >
      {items.map(([label, run]) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          onClick={() => {
            run();
            onClose();
          }}
          className="px-3 py-1 text-left hover:bg-surface-2"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
