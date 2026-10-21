import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { tabKindLabel, tabSchema } from "./tabInfo";

/** The ⌄ button at the end of the tab bar: a filterable list of every tab. */
export function TabList({ workspace }: { workspace: Workspace }) {
  const activateTab = useWorkspaces((s) => s.activateTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workspace.tabs;
    return workspace.tabs.filter((t) =>
      `${t.title} ${tabKindLabel(t)} ${tabSchema(t)}`.toLowerCase().includes(q),
    );
  }, [workspace.tabs, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setHi(0);
  };
  const pick = (tabId: string) => {
    activateTab(workspace.id, tabId);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setHi(0);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = shown[Math.min(hi, shown.length - 1)];
      if (t) pick(t.id);
    }
  };

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label={strings.workspace.tabList}
        {...tip(strings.workspace.tabList)}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex size-7 items-center justify-center rounded-md text-icon outline-none hover:bg-tab focus-visible:focus-ring"
      >
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-pill-border bg-pill text-text shadow-lg">
          <input
            type="search"
            aria-label={strings.workspace.tabListFilter}
            placeholder={strings.workspace.tabListFilter}
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setHi(0);
            }}
            onKeyDown={onKeyDown}
            aria-controls={listId}
            aria-activedescendant={shown[hi] ? `${listId}-${shown[hi].id}` : undefined}
            className="w-full rounded-t-lg border-b border-pill-border bg-search px-2 py-1 text-text outline-none focus-visible:focus-ring-inset"
          />
          {shown.length === 0 ? (
            <p className="p-2 text-text-2">{strings.workspace.tabListEmpty}</p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label={strings.workspace.tabListLabel}
              className="max-h-72 overflow-y-auto py-1"
            >
              {shown.map((t, i) => (
                <li
                  key={t.id}
                  id={`${listId}-${t.id}`}
                  role="option"
                  aria-selected={i === hi}
                  tabIndex={-1}
                  onClick={() => pick(t.id)}
                  onKeyDown={onKeyDown}
                  onMouseMove={() => setHi(i)}
                  className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1 ${
                    i === hi ? "bg-accent-strong text-accent-contrast" : ""
                  }`}
                >
                  <span className={`truncate ${t.kind === "table" && t.preview ? "italic" : ""}`}>
                    {t.title}
                  </span>
                  <span className={`shrink-0 text-xs ${i === hi ? "" : "text-text-2"}`}>
                    {tabKindLabel(t)}
                    {tabSchema(t) && ` · ${tabSchema(t)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
