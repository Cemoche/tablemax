import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type RefObject, useId, useRef, useState } from "react";
import { useAction, useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import type { ConnectionConfig } from "../../lib/types";
import { dotClass, tagClass } from "../chrome/swatch";
import { ContextMenu, type MenuAnchor, keyboardMenuAnchor, restoreFocusOnClose } from "../sidebar/ContextMenu";
import { connectionSubtitle } from "./connectionDraft";
import { DriverTile } from "./DriverTile";

interface Props {
  items: ConnectionConfig[];
  selectedId: string | null;
  /** A click or an arrow key selects a row. */
  onSelect: (cfg: ConnectionConfig) => void;
  /** Enter, a double click or the menu's Connect. */
  onOpen: (cfg: ConnectionConfig) => void;
  /** The menu's Edit…: the connection's form. */
  onEdit: (cfg: ConnectionConfig) => void;
  /** The + button (and Ctrl+N, bound by the app). */
  onNew: () => void;
  /** The search field, for the app to focus it (Ctrl+Shift+K). */
  searchRef?: RefObject<HTMLInputElement | null>;
}

const COLLAPSED_KEY = "tablemax.collapsedGroups";
/** Key of the group-less section (a real group name cannot be empty). */
const UNGROUPED = "";

function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* storage unavailable: the state just is not remembered */
  }
}

const matches = (c: ConnectionConfig, q: string) =>
  [c.name, c.group ?? "", c.host, c.database ?? "", c.sqlitePath ?? ""].some((f) => f.toLowerCase().includes(q));

/**
 * The right pane of the connections screen (spec §2.4): `+` and the search on top, then
 * the connections in collapsible groups (state kept in localStorage), 52 px rows with the
 * engine tile, the colour dot, the name, the tag badge and `tag : host:port : database`.
 * Each group is a listbox under its disclosure button; the rows share one tab stop and
 * the arrow keys move across the open groups.
 */
export function ConnectionList({ items, selectedId, onSelect, onOpen, onEdit, onNew, searchRef: outerSearch }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [menu, setMenu] = useState<{ cfg: ConnectionConfig; anchor: MenuAnchor } | null>(null);
  const ownSearch = useRef<HTMLInputElement>(null);
  const searchRef = outerSearch ?? ownSearch;
  const baseId = useId();
  const optionId = (id: string) => `${baseId}-c-${id}`;
  const newKey = formatShortcut(useEffectiveShortcut("connection.new"));
  const searchKey = formatShortcut(useEffectiveShortcut("connections.search"));
  // The list is only mounted on the connections screen: that is the action's scope.
  useAction("connections.search", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((c) => matches(c, q)) : items;
  const byGroup = new Map<string, ConnectionConfig[]>();
  for (const c of shown) {
    const key = c.group?.trim() || UNGROUPED;
    byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
  }
  for (const rows of byGroup.values()) rows.sort((a, b) => a.name.localeCompare(b.name));
  const names = [...byGroup.keys()].filter((k) => k !== UNGROUPED).sort((a, b) => a.localeCompare(b));
  // Without any group the list stays flat; otherwise Ungrouped comes last.
  const sections = [...names, ...(byGroup.has(UNGROUPED) ? [UNGROUPED] : [])];
  const flat = names.length === 0;
  // A search opens every group that has a result.
  const isOpen = (key: string) => flat || q !== "" || !collapsed.has(key);
  const visible = sections.flatMap((key) => (isOpen(key) ? (byGroup.get(key) ?? []) : []));
  const tabStop = visible.find((c) => c.id === selectedId) ?? visible[0];

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      saveCollapsed(next);
      return next;
    });

  const focusRow = (cfg: ConnectionConfig) => {
    onSelect(cfg);
    document.getElementById(optionId(cfg.id))?.focus();
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, cfg: ConnectionConfig) => {
    const anchor = keyboardMenuAnchor(e);
    if (anchor) return setMenu({ cfg, anchor });
    const i = visible.indexOf(cfg);
    const to =
      e.key === "ArrowDown"
        ? visible[Math.min(i + 1, visible.length - 1)]
        : e.key === "ArrowUp"
          ? visible[Math.max(i - 1, 0)]
          : e.key === "Home"
            ? visible[0]
            : e.key === "End"
              ? visible[visible.length - 1]
              : undefined;
    if (e.key === "Enter") onOpen(cfg);
    else if (to) focusRow(to);
    else return;
    e.preventDefault();
  };

  const onRowMenu = (e: MouseEvent<HTMLDivElement>, cfg: ConnectionConfig) => {
    e.preventDefault();
    onSelect(cfg);
    setMenu({ cfg, anchor: { x: e.clientX, y: e.clientY } });
  };

  const row = (c: ConnectionConfig) => {
    const selected = c.id === selectedId;
    const subtitle = connectionSubtitle(c);
    return (
      <div
        key={c.id}
        id={optionId(c.id)}
        role="option"
        aria-selected={selected}
        aria-label={c.name}
        aria-describedby={`${optionId(c.id)}-sub`}
        tabIndex={c === tabStop ? 0 : -1}
        onClick={() => onSelect(c)}
        onDoubleClick={() => onOpen(c)}
        onKeyDown={(e) => onRowKey(e, c)}
        onContextMenu={(e) => onRowMenu(e, c)}
        className={`mx-2 flex h-13 cursor-default items-center gap-3 rounded-lg px-2.5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
          selected ? "bg-sel" : "hover:bg-row-b"
        }`}
      >
        <DriverTile kind={c.kind} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              data-color-dot=""
              className={`size-2.5 shrink-0 rounded-full ${dotClass(c.color)}`}
            />
            <span className="min-w-0 truncate font-medium text-text">{c.name}</span>
            <span
              aria-hidden
              className={`shrink-0 rounded-sm border border-current px-1.5 text-xs font-bold tracking-wide ${tagClass(c.envTag)}`}
            >
              {strings.statusPill.tags[c.envTag] ?? strings.statusPill.tags.local}
            </span>
          </div>
          <span
            id={`${optionId(c.id)}-sub`}
            className={`truncate font-mono text-xs ${selected ? "text-text" : "text-text-2"}`}
          >
            {subtitle}
          </span>
        </div>
      </div>
    );
  };

  return (
    <section aria-label={strings.connections.title} className="flex h-full min-w-0 flex-1 flex-col bg-content">
      <div className="flex h-13 shrink-0 items-center gap-2 border-b border-sep px-3">
        <button
          type="button"
          onClick={onNew}
          aria-label={strings.connections.new}
          {...tip(strings.connections.new, newKey)}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-pill-border bg-pill text-icon outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Plus aria-hidden className="size-4" />
        </button>
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-2" />
          <input
            ref={searchRef}
            type="search"
            aria-label={strings.connections.searchLabel}
            placeholder={strings.connections.searchPlaceholder}
            {...tip(strings.connections.searchLabel, searchKey)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Down from the search goes to the first row.
              if (e.key === "ArrowDown" && visible[0]) {
                e.preventDefault();
                focusRow(visible[0]);
              }
            }}
            className="h-7 w-full rounded-md border border-pill-border bg-search pr-2 pl-7 text-text outline-none placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {flat ? (
          shown.length > 0 && (
            <div role="listbox" aria-label={strings.connections.title} className="flex flex-col gap-0.5">
              {visible.map(row)}
            </div>
          )
        ) : (
          sections.map((key) => {
            const rows = byGroup.get(key) ?? [];
            const label = key === UNGROUPED ? strings.connections.ungrouped : key;
            const open = isOpen(key);
            const boxId = `${baseId}-g-${key}`;
            return (
              <div key={`group:${key}`} className="mb-1">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={boxId}
                  aria-label={strings.connections.groupToggle(label)}
                  onClick={() => toggle(key)}
                  className="mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-1 rounded-md px-1.5 text-left text-text-2 outline-none hover:bg-row-b focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {open ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                  <span className="text-xs">{rows.length}</span>
                </button>
                <div id={boxId} role="listbox" aria-label={label} hidden={!open} className="flex flex-col gap-0.5">
                  {open && rows.map(row)}
                </div>
              </div>
            );
          })
        )}
        {shown.length === 0 && (
          <p className="px-4 py-2 text-text-2">
            {items.length === 0 ? strings.connections.empty : strings.connections.noMatch}
          </p>
        )}
      </div>
      {menu && (
        <ContextMenu
          label={strings.connections.menuLabel}
          anchor={menu.anchor}
          items={[
            { label: strings.connections.connect, run: () => onOpen(menu.cfg) },
            { label: strings.connections.edit, run: () => onEdit(menu.cfg) },
          ]}
          onClose={(reason) => {
            const id = menu.cfg.id;
            setMenu(null);
            restoreFocusOnClose(reason, () => document.getElementById(optionId(id))?.focus());
          }}
        />
      )}
    </section>
  );
}
