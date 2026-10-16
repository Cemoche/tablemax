import { strings } from "../../lib/strings";
import type { EnvTag } from "../../lib/types";
import { useWorkspaces } from "../../stores/workspaces";

export const ENV_BG: Record<EnvTag, string> = {
  local: "bg-env-local",
  dev: "bg-env-dev",
  staging: "bg-env-staging",
  prod: "bg-env-prod",
};

interface Props {
  /** True while the connections view (not a workspace) is shown. */
  connectionsActive: boolean;
  onShowConnections: () => void;
  onSelectWorkspace: (id: string) => void;
}

export function WorkspaceSwitcher({ connectionsActive, onShowConnections, onSelectWorkspace }: Props) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeWorkspaceId);
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  return (
    <nav
      aria-label={strings.workspace.switcherLabel}
      className="flex items-stretch border-b border-border bg-surface"
    >
      <button
        type="button"
        onClick={onShowConnections}
        aria-pressed={connectionsActive}
        className={`shrink-0 px-3 py-1.5 ${connectionsActive ? "bg-bg font-semibold" : "hover:bg-surface-2"}`}
      >
        {strings.workspace.back}
      </button>
      <ul className="flex min-w-0 flex-1 overflow-x-auto">
        {workspaces.map((w) => {
          const active = !connectionsActive && w.id === activeId;
          return (
            <li
              key={w.id}
              className={`flex shrink-0 items-center border-l border-border ${active ? "bg-bg" : "hover:bg-surface-2"}`}
            >
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelectWorkspace(w.id)}
                className="flex items-center gap-2 py-1.5 pl-3 pr-1"
              >
                <span aria-hidden className={`size-2 rounded-full ${ENV_BG[w.envTag]}`} />
                <span className={active ? "font-semibold" : ""}>{w.name}</span>
              </button>
              <button
                type="button"
                aria-label={strings.workspace.closeWorkspace(w.name)}
                onClick={() => {
                  // The workspace is already gone from the UI; a failed backend close
                  // (e.g. a lost connection) has nothing left to report to.
                  closeWorkspace(w.id).catch(() => {});
                }}
                className="mr-1 rounded-sm px-1.5 hover:bg-surface-2"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
