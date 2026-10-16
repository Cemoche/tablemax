import { useEffect, useMemo, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import type { DbObject } from "../../lib/types";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";

export function ObjectSidebar({ workspace }: { workspace: Workspace }) {
  const setSchema = useWorkspaces((s) => s.setSchema);
  const openTableTab = useWorkspaces((s) => s.openTableTab);
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { id, currentSchema } = workspace;

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
  }, [id, currentSchema]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = q ? objects.filter((o) => o.name.toLowerCase().includes(q)) : objects;
    // Tables first, then views; the backend already sorted by name.
    return [...match.filter((o) => o.kind === "table"), ...match.filter((o) => o.kind === "view")];
  }, [objects, query]);

  return (
    <aside
      aria-label={strings.sidebar.label}
      className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="flex flex-col gap-2 border-b border-border p-2">
        <select
          aria-label={strings.sidebar.schema}
          value={currentSchema ?? ""}
          onChange={(e) => setSchema(id, e.target.value)}
          className="rounded-sm border border-border bg-bg px-2 py-1"
        >
          {workspace.schemas.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
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
        {!loading && !error && shown.length === 0 && (
          <p className="p-2 text-muted">
            {objects.length === 0 ? strings.sidebar.empty : strings.sidebar.noMatch}
          </p>
        )}
        <ul>
          {shown.map((o) => (
            <li key={`${o.kind}:${o.name}`}>
              <button
                type="button"
                onClick={() => openTableTab(id, { schema: o.schema, name: o.name })}
                className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-surface-2"
              >
                <span
                  aria-label={o.kind === "table" ? strings.sidebar.table : strings.sidebar.view}
                  role="img"
                  className={o.kind === "table" ? "text-accent" : "text-muted"}
                >
                  {o.kind === "table" ? strings.sidebar.tableIcon : strings.sidebar.viewIcon}
                </span>
                <span className="truncate">{o.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
