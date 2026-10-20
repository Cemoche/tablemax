import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  type UIEvent,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
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
import { ContextMenu, type MenuAnchor, type MenuItem, restoreFocusOnClose } from "../sidebar/ContextMenu";
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
  /**
   * The open menu, and the row it came from by key (its index as a fallback): the focus
   * goes back to that row on close, even if the rows moved meanwhile.
   */
  const [menu, setMenu] = useState<{ entry: Entry; anchor: MenuAnchor; row: number } | null>(null);
  /** The row last clicked; until another tab is shown, it wins over the active tab's object. */
  const [selected, setSelected] = useState<string | null>(null);
  const tree = useRef<TreeApi | null>(null);
  const { id, currentSchema, database, activeTabId } = workspace;
  const caps = capabilitiesOf(workspace);
  const { match, showTables, showViews } = useSidebar(
    useShallow((s) => ({ match: s.match, showTables: s.showTables, showViews: s.showViews })),
  );
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
  // Another tab shown: the selection follows it again.
  useEffect(() => setSelected(null), [activeTabId]);
  const activeTab = workspace.tabs.find((t) => t.id === activeTabId);
  const activeObject =
    activeTab?.kind === "table"
      ? objects.find((o) => o.name === activeTab.object.name && o.schema === activeTab.object.schema)
      : undefined;
  const activeKey = activeObject ? entryKey({ type: "object", object: activeObject }) : null;
  const selectedKey = selected ?? activeKey;

  const refresh = () => {
    setReload((n) => n + 1);
    // Rebuild the catalog (backend cache and palette store); never blocks the UI.
    void useCatalog.getState().refreshCatalog(id, currentSchema);
  };

  const fail = (e: unknown) => setNotice(S.copyFailed(toAppError(e).message));

  const menuItems = (entry: Entry): MenuItem[] => {
    const copyName = {
      label: S.menu.copyName,
      run: () => {
        setNotice(null);
        copyText(entryName(entry)).catch(fail);
      },
    };
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
          if (ws?.activeTabId) useChrome.getState().setTableView(ws.activeTabId, "structure");
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
        apiRef={tree}
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
        onMenu={(entry, anchor, row) => {
          setSelected(entryKey(entry));
          setMenu({ entry, anchor, row });
        }}
      />
      {menu && (
        <ContextMenu
          label={S.menuLabel}
          anchor={menu.anchor}
          items={menuItems(menu.entry)}
          onClose={(reason) => {
            setMenu(null);
            const { entry, row } = menu;
            restoreFocusOnClose(reason, () => tree.current?.focusKey(entryKey(entry), row));
          }}
        />
      )}
    </section>
  );
}

/** What the Items tab asks of its tree. */
export interface TreeApi {
  /**
   * Focuses the row with key `key` (an `entryKey`), else row `fallback` (clamped), scrolled
   * into view (rendered first if needed).
   */
  focusKey: (key: string, fallback: number) => void;
}

interface TreeProps {
  apiRef: RefObject<TreeApi | null>;
  rows: Row[];
  rowHeight: number;
  fontSize: number;
  selectedKey: string | null;
  onToggle: (key: string) => void;
  /** Click (preview) or double click / Enter (permanent) on an object; a routine opens its menu. */
  onSelect: (entry: Entry, permanent: boolean) => void;
  onMenu: (entry: Entry, anchor: MenuAnchor, row: number) => void;
}

/** Level, set size, position and parent row of each row (the tree is virtualized). */
interface RowMeta {
  level: 1 | 2;
  setSize: number;
  posInSet: number;
  /** The section row of an object or routine. */
  parent: number | null;
}

function rowMeta(rows: Row[]): RowMeta[] {
  const sections = rows.filter((r) => r.type === "section").length;
  const meta: RowMeta[] = [];
  let section = -1;
  let sectionPos = 0;
  let childPos = 0;
  rows.forEach((r, i) => {
    if (r.type === "section") {
      section = i;
      childPos = 0;
      meta.push({ level: 1, setSize: sections, posInSet: ++sectionPos, parent: null });
    } else {
      const head = rows[section];
      meta.push({
        level: 2,
        setSize: head?.type === "section" ? head.count : 0,
        posInSet: ++childPos,
        parent: section >= 0 ? section : null,
      });
    }
  });
  return meta;
}

/**
 * The tree (ARIA tree pattern): fixed-height rows, only those in view (plus some)
 * rendered, so `aria-setsize` / `aria-posinset` tell where each row sits. A single Tab
 * stop (roving tabindex); Up / Down, Home / End, Right (expand, then first child), Left
 * (collapse, or back to the section), Enter (open), Space (preview), Shift+F10 (menu).
 */
function Tree({ apiRef, rows, rowHeight, fontSize, selectedKey, onToggle, onSelect, onMenu }: TreeProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  /**
   * The row that last had the focus (the Tab stop), by key so a search, a collapse or a
   * refresh keeps it on the same row; its index then, for when the key is gone.
   */
  const [focused, setFocused] = useState<{ key: string; index: number } | null>(null);
  /** A row to focus once it is rendered (keys past the rendered ones). */
  const pendingFocus = useRef<number | null>(null);
  const meta = useMemo(() => rowMeta(rows), [rows]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const indexOfKey = (key: string) => rows.findIndex((r) => rowKey(r) === key);
  const clampRow = (n: number) => Math.max(0, Math.min(rows.length - 1, n));
  const selectedIndex = selectedKey === null ? -1 : indexOfKey(selectedKey);
  const focusedIndex = focused ? indexOfKey(focused.key) : -1;
  const tabStop =
    rows.length === 0
      ? -1
      : focusedIndex >= 0
        ? focusedIndex
        : focused
          ? clampRow(focused.index)
          : selectedIndex >= 0
            ? selectedIndex
            : 0;

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  const indices: number[] = [];
  // The Tab stop is always in the DOM, even scrolled away, so Tab can reach the tree.
  if (tabStop >= 0 && tabStop < first) indices.push(tabStop);
  for (let i = first; i < last; i++) indices.push(i);
  if (tabStop >= last) indices.push(tabStop);

  useEffect(() => {
    const n = pendingFocus.current;
    if (n === null) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-row-index="${n}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const focusRow = (wanted: number) => {
    const el = scroller.current;
    if (!el || rows.length === 0) return;
    const n = clampRow(wanted);
    setFocused({ key: rowKey(rows[n]), index: n });
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
  const focusRef = useRef(focusRow);
  focusRef.current = focusRow;
  const keyIndexRef = useRef(indexOfKey);
  keyIndexRef.current = indexOfKey;
  useImperativeHandle(
    apiRef,
    () => ({
      focusKey: (key, fallback) => {
        const n = keyIndexRef.current(key);
        focusRef.current(n >= 0 ? n : fallback);
      },
    }),
    [],
  );

  const menuAt = (row: Entry, index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onMenu(row, { x: r.left, y: r.bottom }, index);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const at = Number(target.dataset.rowIndex);
    const row = rows[at];
    if (!Number.isFinite(at) || !row) return;
    const m = meta[at];
    switch (e.key) {
      case "ArrowDown":
        focusRow(at + 1);
        break;
      case "ArrowUp":
        focusRow(at - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.type === "section") {
          if (!row.expanded) onToggle(row.key);
          else if (rows[at + 1] && rows[at + 1].type !== "section") focusRow(at + 1);
        }
        break;
      case "ArrowLeft":
        if (row.type === "section") {
          if (row.expanded) onToggle(row.key);
        } else if (m.parent !== null) focusRow(m.parent);
        break;
      case "Enter":
      case " ":
        if (row.type === "section") onToggle(row.key);
        else if (row.type === "routine") menuAt(row, at, target);
        else onSelect(row, e.key === "Enter");
        break;
      case "ContextMenu":
      case "F10":
        if (row.type === "section" || (e.key === "F10" && !e.shiftKey)) return;
        menuAt(row, at, target);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const rowClass = (selected: boolean) =>
    `absolute inset-x-1.5 flex items-center gap-1.5 rounded-md px-1.5 text-left whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent ${
      selected ? "bg-sel" : "hover:bg-seg-sel"
    }`;

  const shown = indices.map((index) => {
    const row = rows[index];
    const m = meta[index];
    const common = {
      role: "treeitem",
      "data-row-index": index,
      "aria-level": m.level,
      "aria-setsize": m.setSize,
      "aria-posinset": m.posInSet,
      tabIndex: index === tabStop ? 0 : -1,
      onFocus: () => setFocused({ key: rowKey(row), index }),
      style: { top: index * rowHeight, height: rowHeight },
    } as const;
    if (row.type === "section") {
      const Chevron = row.expanded ? ChevronDown : ChevronRight;
      return (
        <div
          key={rowKey(row)}
          {...common}
          aria-label={row.label}
          aria-expanded={row.expanded}
          onClick={() => onToggle(row.key)}
          className={`${rowClass(false)} font-sans text-xs font-semibold text-text-2`}
        >
          <Chevron aria-hidden size={13} strokeWidth={1.8} className="shrink-0" />
          <span>{row.label}</span>
          <span aria-hidden="true" className="ml-auto font-normal">
            {row.count}
          </span>
        </div>
      );
    }
    const name = entryName(row);
    const selected = selectedKey === entryKey(row);
    return (
      <div
        key={rowKey(row)}
        {...common}
        aria-label={name}
        aria-selected={selected}
        title={name}
        data-object-row={row.type === "object" ? name : undefined}
        onClick={(e) => {
          if (row.type === "routine") menuAt(row, index, e.currentTarget);
          else onSelect(row, false);
        }}
        onDoubleClick={() => {
          if (row.type === "object") onSelect(row, true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(row, { x: e.clientX, y: e.clientY }, index);
        }}
        className={`${rowClass(selected)} pl-6 text-text`}
      >
        <ObjectIcon kind={row.type === "object" ? row.object.kind : row.routine.kind} />
        <span className="min-w-0 truncate">{name}</span>
      </div>
    );
  });

  return (
    <div
      ref={scroller}
      role="tree"
      aria-label={S.treeLabel}
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
