import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { qualifiedName } from "../../lib/sqlIdent";
import { strings } from "../../lib/strings";
import type { DbObject, DbRoutine } from "../../lib/types";
import { useCatalog } from "../../stores/catalog";
import { useChrome, useOnRequest } from "../../stores/chrome";
import { useSettings } from "../../stores/settings";
import { useSidebar } from "../../stores/sidebar";
import { type Workspace, capabilitiesOf, sqlDialect, useWorkspaces } from "../../stores/workspaces";
import { ContextMenu, type MenuAnchor, type MenuItem, keyboardMenuAnchor } from "../sidebar/ContextMenu";
import { ObjectIcon } from "../sidebar/ObjectIcon";
import { SidebarSearch, nameMatches } from "../sidebar/SidebarSearch";
import { copyText } from "../sidebar/sqlActions";

const S = strings.sidebar;

type Entry = { type: "object"; object: DbObject } | { type: "routine"; routine: DbRoutine };

type Row =
  | { type: "section"; key: string; label: string; count: number; expanded: boolean }
  | Entry;

/** Rows kept rendered above and below the visible ones. */
const OVERSCAN = 12;
/** Before the tree is measured (and in tests, where nothing is laid out). */
const FALLBACK_VIEWPORT = 800;

/** Spec §5.2: 24 px rows at the default 13 px; taller only for big data fonts. */
export const treeRowHeight = (fontSize: number) => Math.max(24, Math.ceil(fontSize * 1.6));

const entryName = (e: Entry) => (e.type === "object" ? e.object.name : e.routine.name);
const entryKey = (e: Entry) =>
  e.type === "object" ? `o:${e.object.kind}:${e.object.name}` : `r:${e.routine.kind}:${e.routine.name}`;
const rowKey = (r: Row) => (r.type === "section" ? `s:${r.key}` : entryKey(r));

/**
 * The sidebar's Items tab: the schema's tables, views and routines in a virtualized tree
 * (only the rows in view are in the DOM, so thousands of objects stay fast), with the
 * search box and its options. A click opens a preview tab, a double click a permanent one.
 */
export function ObjectSidebar({ workspace }: { workspace: Workspace }) {
  const openTableTab = useWorkspaces((s) => s.openTableTab);
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [routines, setRoutines] = useState<DbRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ entry: Entry; anchor: MenuAnchor } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { id, currentSchema, database } = workspace;
  const caps = capabilitiesOf(workspace);
  const { match, showTables, showViews } = useSidebar();
  const fontSize = useSettings((s) => s.settings.dataFontSize);
  const rowHeight = treeRowHeight(fontSize);

  // The toolbar's Reload (Mod+R) and the footer's Refresh reload the lists; they rebuild
  // the catalog themselves.
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
    if (!caps.routines) return;
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
  }, [id, caps.routines, currentSchema, database, reload]);

  const { tables, views, shownRoutines } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const keep = <T extends { name: string }>(l: T[]) => l.filter((o) => nameMatches(o.name, q, match));
    const objs = keep(objects);
    return {
      tables: showTables ? objs.filter((o) => o.kind === "table") : [],
      views: showViews ? objs.filter((o) => o.kind === "view") : [],
      shownRoutines: caps.routines ? keep(routines) : [],
    };
  }, [objects, routines, query, match, showTables, showViews, caps.routines]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const section = (key: string, label: string, entries: Entry[], show: boolean) => {
      if (!show) return;
      const expanded = !collapsed[key];
      out.push({ type: "section", key, label, count: entries.length, expanded });
      if (expanded) out.push(...entries);
    };
    section("tables", S.tables, tables.map((object) => ({ type: "object", object })), showTables);
    section("views", S.views, views.map((object) => ({ type: "object", object })), showViews);
    section(
      "routines",
      S.routines,
      shownRoutines.map((routine) => ({ type: "routine", routine })),
      caps.routines,
    );
    return out;
  }, [tables, views, shownRoutines, collapsed, showTables, showViews, caps.routines]);

  // The active table tab's object is the selected row until another row is clicked.
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId);
  const activeKey =
    activeTab?.kind === "table" ? `o:${objects.find((o) => o.name === activeTab.object.name)?.kind}:${activeTab.object.name}` : null;
  const selectedKey = selected ?? activeKey;

  const refresh = () => {
    setReload((n) => n + 1);
    // Rebuild the catalog (backend cache and palette store); never blocks the UI.
    void useCatalog.getState().refreshCatalog(id, currentSchema);
  };

  const fail = (e: unknown) => setNotice(S.copyFailed(toAppError(e).message));

  const menuItems = (entry: Entry): MenuItem[] => {
    const copyName = { label: S.menu.copyName, run: () => void copyText(entryName(entry)).catch(() => {}) };
    const refreshItem = { label: S.menu.refresh, run: refresh };
    if (entry.type === "routine") return [copyName, refreshItem];
    const o = entry.object;
    const ref = { schema: o.schema, name: o.name };
    const scripts: MenuItem[] = [
      ...(caps.ddl
        ? [
            {
              label: S.menu.create,
              ariaLabel: S.menu.copyCreate,
              indent: true,
              run: () => {
                setNotice(null);
                ipc.tableDdl(id, ref).then(copyText).catch(fail);
              },
            },
          ]
        : []),
      ...(caps.sqlEditor
        ? [
            {
              label: S.menu.selectTop,
              ariaLabel: S.menu.copySelectTop,
              indent: true,
              run: () =>
                void copyText(
                  `SELECT * FROM ${qualifiedName(sqlDialect(workspace), o.schema, o.name)} LIMIT 100;`,
                ).catch(fail),
            },
          ]
        : []),
    ];
    return [
      { label: S.menu.openNewTab, run: () => openTableTab(id, ref) },
      {
        label: S.menu.openStructure,
        run: () => {
          openTableTab(id, ref);
          const ws = useWorkspaces.getState().workspaces.find((w) => w.id === id);
          if (ws?.activeTabId) useChrome.getState().requestTableView(ws.activeTabId, "structure");
        },
      },
      copyName,
      ...(scripts.length > 0 ? [{ heading: S.menu.copyScriptAs }, ...scripts] : []),
      refreshItem,
    ];
  };

  const nothing = objects.length === 0 && routines.length === 0;
  const nothingShown = tables.length + views.length + shownRoutines.length === 0;

  return (
    <section aria-label={S.itemsLabel} className="flex min-h-0 flex-1 flex-col">
      <SidebarSearch
        label={S.searchLabel}
        placeholder={S.search}
        value={query}
        onChange={setQuery}
        withOptions
      />
      {error && <p className="px-3 py-1 text-danger">{error}</p>}
      {notice && (
        <p role="alert" className="px-3 py-1 text-danger">
          {notice}
        </p>
      )}
      {loading && <p className="px-3 py-1 text-text-2">{S.loading}</p>}
      {!loading && !error && nothingShown && (
        <p className="px-3 py-1 text-text-2">{nothing ? S.empty : S.noMatch}</p>
      )}
      <Tree
        rows={rows}
        rowHeight={rowHeight}
        fontSize={fontSize}
        selectedKey={selectedKey}
        onToggle={(key) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
        onSelect={(entry, permanent) => {
          setSelected(entryKey(entry));
          if (entry.type === "object") {
            const o = entry.object;
            openTableTab(id, { schema: o.schema, name: o.name }, { preview: !permanent });
          }
        }}
        onMenu={(entry, anchor) => setMenu({ entry, anchor })}
      />
      {menu && (
        <ContextMenu
          label={S.menuLabel}
          anchor={menu.anchor}
          items={menuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

interface TreeProps {
  rows: Row[];
  rowHeight: number;
  fontSize: number;
  selectedKey: string | null;
  onToggle: (key: string) => void;
  /** Click (preview) or double click (permanent) on an object; a routine opens its menu. */
  onSelect: (entry: Entry, permanent: boolean) => void;
  onMenu: (entry: Entry, anchor: MenuAnchor) => void;
}

/** Fixed-height rows, only those in view (plus some) rendered. */
function Tree({ rows, rowHeight, fontSize, selectedKey, onToggle, onSelect, onMenu }: TreeProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  /** A row to focus once it is rendered (arrow keys past the rendered ones). */
  const pendingFocus = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);

  useEffect(() => {
    const n = pendingFocus.current;
    if (n === null) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-row-index="${n}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const focusRow = (n: number) => {
    const el = scroller.current;
    if (!el || n < 0 || n >= rows.length) return;
    const top = n * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + viewport) el.scrollTop = top + rowHeight - viewport;
    const target = el.querySelector<HTMLElement>(`[data-row-index="${n}"]`);
    if (target) target.focus();
    else {
      pendingFocus.current = n;
      setScrollTop(el.scrollTop);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const at = Number((e.target as HTMLElement).dataset.rowIndex);
    if (!Number.isFinite(at)) return;
    e.preventDefault();
    focusRow(at + (e.key === "ArrowDown" ? 1 : -1));
  };

  const rowClass = (selected: boolean) =>
    `absolute inset-x-1.5 flex items-center gap-1.5 rounded-md px-1.5 text-left whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent ${
      selected ? "bg-sel" : "hover:bg-seg-sel"
    }`;

  const shown = rows.slice(first, last).map((row, i) => {
    const index = first + i;
    const style = { top: index * rowHeight, height: rowHeight };
    if (row.type === "section") {
      const Chevron = row.expanded ? ChevronDown : ChevronRight;
      return (
        <button
          key={rowKey(row)}
          type="button"
          data-row-index={index}
          aria-expanded={row.expanded}
          onClick={() => onToggle(row.key)}
          style={style}
          className={`${rowClass(false)} font-sans text-xs font-semibold text-text-2`}
        >
          <Chevron aria-hidden size={13} strokeWidth={1.8} className="shrink-0" />
          <span>{row.label}</span>
          <span aria-hidden="true" className="ml-auto font-normal">
            {row.count}
          </span>
        </button>
      );
    }
    const name = entryName(row);
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      onMenu(row, { x: e.clientX, y: e.clientY });
    };
    const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
      const anchor = keyboardMenuAnchor(e);
      if (anchor) onMenu(row, anchor);
    };
    const selected = selectedKey === entryKey(row);
    if (row.type === "routine") {
      return (
        <button
          key={rowKey(row)}
          type="button"
          title={name}
          data-row-index={index}
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            onMenu(row, { x: b.left, y: b.bottom });
          }}
          onContextMenu={onContextMenu}
          onKeyDown={onKey}
          style={style}
          className={`${rowClass(selected)} pl-6 text-text`}
        >
          <ObjectIcon kind={row.routine.kind} />
          <span className="min-w-0 truncate">{name}</span>
        </button>
      );
    }
    return (
      <button
        key={rowKey(row)}
        type="button"
        title={name}
        data-row-index={index}
        data-object-row={name}
        onClick={() => onSelect(row, false)}
        onDoubleClick={() => onSelect(row, true)}
        onContextMenu={onContextMenu}
        onKeyDown={onKey}
        style={style}
        className={`${rowClass(selected)} pl-6 text-text`}
      >
        <ObjectIcon kind={row.object.kind} />
        <span className="min-w-0 truncate">{name}</span>
      </button>
    );
  });

  return (
    <div
      ref={scroller}
      data-tree=""
      onScroll={(e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      style={{ fontSize }}
      className="relative min-h-0 flex-1 overflow-y-auto pb-1 font-mono"
    >
      <div style={{ height: rows.length * rowHeight }} className="relative">
        {shown}
      </div>
    </div>
  );
}
