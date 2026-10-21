import { Check, Search, SlidersHorizontal } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import { useShallow } from "zustand/react/shallow";
import { type MatchMode, useSidebar } from "../../stores/sidebar";
import { moveMenuFocus } from "./ContextMenu";

const S = strings.sidebar;
const MODES: MatchMode[] = ["contains", "startsWith", "endsWith"];

/** Does `name` match the Items search `query` (lowercase) in `mode`? */
export function nameMatches(name: string, query: string, mode: MatchMode): boolean {
  if (!query) return true;
  const n = name.toLowerCase();
  if (mode === "startsWith") return n.startsWith(query);
  if (mode === "endsWith") return n.endsWith(query);
  return n.includes(query);
}

interface Props {
  /** Accessible name of the box. */
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Items only: the options menu (match mode, tables, views). */
  withOptions?: boolean;
}

/**
 * The search box at the top of a sidebar tab ("Search for item…"). It takes the focus when
 * `sidebar.search` (Ctrl+Shift+F) asks, also right after the sidebar was shown.
 */
export function SidebarSearch({ label, placeholder, value, onChange, withOptions = false }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const focusSearch = useSidebar((s) => s.focusSearch);
  useEffect(() => {
    if (!useSidebar.getState().focusSearch) return;
    useSidebar.setState({ focusSearch: false });
    input.current?.focus();
    input.current?.select();
  }, [focusSearch]);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-2.5 pb-1.5">
      <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-pill-border bg-search px-2 focus-within:outline-2 focus-within:outline-solid focus-within:-outline-offset-1 focus-within:outline-accent">
        <Search aria-hidden size={14} strokeWidth={1.6} className="shrink-0 text-icon-dim" />
        <input
          ref={input}
          type="search"
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.stopPropagation();
              onChange("");
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-2"
        />
      </div>
      {withOptions && <SearchOptions />}
    </div>
  );
}

function SearchOptions() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { match, showTables, showViews, setSearchOptions } = useSidebar(
    useShallow((s) => ({
      match: s.match,
      showTables: s.showTables,
      showViews: s.showViews,
      setSearchOptions: s.setSearchOptions,
    })),
  );

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (fn: () => void) => () => {
    fn();
    close(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])];
    if (moveMenuFocus(e.key, els)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") close(true);
    else if (e.key === "Tab") close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const item = "mx-1 flex items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent-strong hover:text-accent-contrast focus-visible:bg-accent-strong focus-visible:text-accent-contrast";
  const tick = (on: boolean) => (
    <Check aria-hidden size={13} strokeWidth={2} className={on ? "" : "invisible"} />
  );

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-label={S.searchOptions}
        {...tip(S.searchOptions)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-7 items-center justify-center rounded-md text-icon outline-none hover:bg-seg-sel aria-expanded:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
      >
        <SlidersHorizontal aria-hidden size={14} strokeWidth={1.6} />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={S.searchOptions}
          onKeyDown={onKeyDown}
          className="absolute top-8 right-0 z-50 flex min-w-40 flex-col rounded-lg border border-pill-border bg-pill py-1 text-text shadow-lg"
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={match === m}
              onClick={choose(() => setSearchOptions({ match: m }))}
              className={item}
            >
              {tick(match === m)}
              {S.match[m]}
            </button>
          ))}
          <div role="separator" className="my-1 border-t border-pill-border" />
          <div role="presentation" className="px-3 pb-0.5 text-xs text-text-2">
            {S.show}
          </div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showTables}
            onClick={choose(() => setSearchOptions({ showTables: !showTables }))}
            className={item}
          >
            {tick(showTables)}
            {S.showTables}
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showViews}
            onClick={choose(() => setSearchOptions({ showViews: !showViews }))}
            className={item}
          >
            {tick(showViews)}
            {S.showViews}
          </button>
        </div>
      )}
    </div>
  );
}
