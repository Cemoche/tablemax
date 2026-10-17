import { useEffect, useRef, useState } from "react";
import { isModalOpen, matchShortcut } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { tabKindLabel, tabsByMru } from "./tabInfo";

/**
 * Ctrl+Tab (held) opens the tabs in MRU order, selection on the 2nd entry; each extra
 * Tab advances, Shift+Tab goes back; releasing Control activates; Escape cancels.
 * Literally Ctrl on every platform (not `Mod`), as in the plan's defaults.
 */
export function TabSwitcher({ workspace }: { workspace: Workspace }) {
  const activateTab = useWorkspaces((s) => s.activateTab);
  const [index, setIndex] = useState<number | null>(null);
  const indexRef = useRef<number | null>(null);
  const wsRef = useRef(workspace);
  wsRef.current = workspace;
  const { id } = workspace;

  useEffect(() => {
    const set = (i: number | null) => {
      indexRef.current = i;
      setIndex(i);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const fwd = matchShortcut(e, "Ctrl+Tab");
      const back = matchShortcut(e, "Ctrl+Shift+Tab");
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
      const n = tabsByMru(wsRef.current).length;
      if (n < 2) return;
      set(fwd ? 1 : n - 1);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const cur = indexRef.current;
      if (cur === null || e.key !== "Control") return;
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
  }, [id, activateTab]);

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
