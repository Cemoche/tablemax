import { useEffect, useRef, useState } from "react";
import { useEffectiveShortcut } from "../../lib/keymap";
import { isMac } from "../../lib/platform";
import { isModalOpen, matchShortcut } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { tabKindLabel, tabsByMru } from "./tabInfo";

/**
 * The keys (`KeyboardEvent.key`) of the modifiers a spec holds down while its key is
 * pressed again: Ctrl, Cmd (Meta) or Alt — Shift only selects the direction. `Mod` is Cmd
 * on macOS and Ctrl elsewhere.
 */
export function heldModifiers(spec: string, mac: boolean = isMac()): string[] {
  const held = new Set<string>();
  for (const m of spec.split("+").slice(0, -1)) {
    if (m === "Ctrl" || (m === "Mod" && !mac)) held.add("Control");
    else if (m === "Meta" || (m === "Mod" && mac)) held.add("Meta");
    else if (m === "Alt") held.add("Alt");
  }
  return [...held];
}

/**
 * `tab.next` (Ctrl+Tab by default) held opens the tabs in MRU order, selection on the 2nd
 * entry; each extra press advances, `tab.previous` (Ctrl+Shift+Tab) goes back; releasing
 * the held modifier activates; Escape cancels. Literally Ctrl on every platform (not
 * `Mod`), as in the plan's defaults. A combination with no modifier to hold (F6) switches
 * once per press, to the tab the list would have selected. Not while a modal is open.
 */
export function TabSwitcher({ workspace }: { workspace: Workspace }) {
  const activateTab = useWorkspaces((s) => s.activateTab);
  const nextSpec = useEffectiveShortcut("tab.next");
  const prevSpec = useEffectiveShortcut("tab.previous");
  const [index, setIndex] = useState<number | null>(null);
  const indexRef = useRef<number | null>(null);
  const wsRef = useRef(workspace);
  wsRef.current = workspace;
  const { id } = workspace;
  /** The modifier keys whose release activates the selection (those of the opening spec). */
  const heldRef = useRef<string[]>([]);

  useEffect(() => {
    const set = (i: number | null) => {
      indexRef.current = i;
      setIndex(i);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const fwd = matchShortcut(e, nextSpec);
      const back = !fwd && matchShortcut(e, prevSpec);
      const cur = indexRef.current;
      if (cur !== null) {
        if (fwd || back) {
          e.preventDefault();
          const n = tabsByMru(wsRef.current).length;
          set((cur + (fwd ? 1 : -1) + n) % n);
        } else if (e.code === "Escape") {
          e.preventDefault();
          set(null);
        }
        return;
      }
      if (!fwd && !back) return;
      if (isModalOpen()) return;
      e.preventDefault();
      const tabs = tabsByMru(wsRef.current);
      const n = tabs.length;
      if (n < 2) return;
      const target = fwd ? 1 : n - 1;
      heldRef.current = heldModifiers(fwd ? nextSpec : prevSpec);
      // Nothing held to release: no list to cycle, switch now.
      if (heldRef.current.length === 0) activateTab(id, tabs[target].id);
      else set(target);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const cur = indexRef.current;
      if (cur === null || !heldRef.current.includes(e.key)) return;
      const tab = tabsByMru(wsRef.current)[cur];
      set(null);
      if (tab) activateTab(id, tab.id);
    };
    const cancel = () => set(null);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", cancel);
    };
  }, [id, activateTab, nextSpec, prevSpec]);

  if (index === null) return null;
  const tabs = tabsByMru(workspace);
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <ul
        role="listbox"
        aria-label={strings.workspace.tabSwitcherLabel}
        className="pointer-events-auto max-h-96 w-80 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
      >
        {tabs.map((t, i) => (
          <li
            key={t.id}
            role="option"
            aria-selected={i === index}
            className={`flex items-center justify-between gap-2 px-3 py-1 ${
              i === index ? "bg-surface-2 text-fg" : "text-muted"
            }`}
          >
            <span className={`truncate ${t.kind === "table" && t.preview ? "italic" : ""}`}>
              {t.title}
            </span>
            <span className="shrink-0 text-xs">{tabKindLabel(t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
