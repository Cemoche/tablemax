import { useState } from "react";
import { strings } from "../../lib/strings";
import type { ConnectionConfig } from "../../lib/types";

interface Props {
  items: ConnectionConfig[];
  selectedId: string | null;
  onSelect: (cfg: ConnectionConfig) => void;
  onOpen: (cfg: ConnectionConfig) => void;
  onNew: () => void;
}

const ENV_CLASS: Record<ConnectionConfig["envTag"], string> = {
  local: "text-env-local border-env-local",
  dev: "text-env-dev border-env-dev",
  staging: "text-env-staging border-env-staging",
  prod: "text-env-prod border-env-prod",
};

export function ConnectionList({ items, selectedId, onSelect, onOpen, onNew }: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((c) => c.name.toLowerCase().includes(q)) : items;
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
        <button
          type="button"
          onClick={onNew}
          title={strings.connections.new}
          aria-label={strings.connections.new}
          className="rounded-sm border border-border px-2 py-1"
        >
          +
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {shown.map((c) => (
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
        ))}
        {shown.length === 0 && (
          <li className="px-3 py-2 text-muted">
            {items.length === 0 ? strings.connections.empty : strings.connections.noMatch}
          </li>
        )}
      </ul>
    </aside>
  );
}
