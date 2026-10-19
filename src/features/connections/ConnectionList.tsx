import { useEffect, useRef, useState } from "react";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";

interface Props {
  items: ConnectionConfig[];
  selectedId: string | null;
  onSelect: (cfg: ConnectionConfig) => void;
  onOpen: (cfg: ConnectionConfig) => void;
  onNew: () => void;
  onNewFromUrl: () => void;
  onImport: () => void;
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

const ENV_CLASS: Record<ConnectionConfig["envTag"], string> = {
  local: "text-env-local border-env-local",
  dev: "text-env-dev border-env-dev",
  staging: "text-env-staging border-env-staging",
  prod: "text-env-prod border-env-prod",
};

export function ConnectionList({
  items,
  selectedId,
  onSelect,
  onOpen,
  onNew,
  onNewFromUrl,
  onImport,
}: Props) {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const q = query.trim().toLowerCase();
  const shown = q
    ? items.filter((c) =>
        [c.name, c.group ?? "", c.host].some((field) => field.toLowerCase().includes(q)),
      )
    : items;

  const byGroup = new Map<string, ConnectionConfig[]>();
  for (const c of shown) {
    const key = c.group?.trim() || UNGROUPED;
    byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
  }
  const names = [...byGroup.keys()].filter((k) => k !== UNGROUPED).sort((a, b) => a.localeCompare(b));
  // Without any group the list stays flat; otherwise Ungrouped comes last.
  const sections = names.length
    ? [...names, ...(byGroup.has(UNGROUPED) ? [UNGROUPED] : [])]
    : byGroup.has(UNGROUPED)
      ? [UNGROUPED]
      : [];
  const flat = names.length === 0;

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      saveCollapsed(next);
      return next;
    });

  const row = (c: ConnectionConfig) => (
    <li key={c.id}>
      <button
        type="button"
        onClick={() => onSelect(c)}
        onDoubleClick={() => onOpen(c)}
        aria-current={c.id === selectedId}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 ${
          c.id === selectedId ? "bg-surface-2" : ""
        }`}
      >
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: `var(--${c.color})` }}
        />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        <span className={`rounded-sm border px-1 text-xs ${ENV_CLASS[c.envTag]}`}>
          {strings.env[c.envTag]}
        </span>
      </button>
    </li>
  );
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <input
          type="search"
          aria-label={strings.connections.searchLabel}
          placeholder={strings.connections.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1"
        />
        <div
          ref={menuRef}
          className="relative"
          onKeyDown={(e) => e.key === "Escape" && setMenuOpen(false)}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            title={strings.connections.newMenu}
            aria-label={strings.connections.newMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="rounded-sm border border-border px-2 py-1"
          >
            +
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-10 mt-1 w-56 rounded-sm border border-border bg-surface py-1 shadow-lg"
            >
              {(
                [
                  [strings.connections.new, onNew],
                  [strings.connections.newFromUrl, onNewFromUrl],
                  [strings.connections.importTablePlus, onImport],
                ] as const
              ).map(([label, action]) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    action();
                  }}
                  className="block w-full px-3 py-1 text-left hover:bg-surface-2"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {sections.map((key) => {
          const rows = byGroup.get(key) ?? [];
          if (flat) return rows.map(row);
          const label = key === UNGROUPED ? strings.connections.ungrouped : key;
          // A search opens every group that has a result.
          const open = q !== "" || !collapsed.has(key);
          return (
            <li key={`group:${key}`}>
              <button
                type="button"
                aria-expanded={open}
                aria-label={strings.connections.groupToggle(label)}
                onClick={() => toggle(key)}
                className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs font-semibold text-muted uppercase hover:bg-surface-2"
              >
                <span aria-hidden>{open ? "▾" : "▸"}</span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span>{rows.length}</span>
              </button>
              {open && <ul>{rows.map(row)}</ul>}
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-3 py-2 text-muted">
            {items.length === 0 ? strings.connections.empty : strings.connections.noMatch}
          </li>
        )}
      </ul>
    </aside>
  );
}
