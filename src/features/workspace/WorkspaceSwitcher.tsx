import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { ENV_BG } from "./envClasses";
import { useLiveEnv } from "./useLiveEnv";

interface Props {
  /** True while the connections view (not a workspace) is shown. */
  connectionsActive: boolean;
  onShowConnections: () => void;
  onSelectWorkspace: (id: string) => void;
}

interface ItemProps {
  workspace: Workspace;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onClose: () => void;
}

/** One hook call per workspace: the dot shows the live saved tag, like the banner. */
function SwitcherItem({ workspace: w, active, busy, onSelect, onClose }: ItemProps) {
  const { envTag } = useLiveEnv(w);
  return (
    <li
      className={`flex shrink-0 items-center border-l border-border ${active ? "bg-bg" : "hover:bg-surface-2"}`}
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className="flex items-center gap-2 py-1.5 pl-3 pr-1"
      >
        <span aria-hidden className={`size-2 rounded-full ${ENV_BG[envTag]}`} />
        <span className={active ? "font-semibold" : ""}>{w.name}</span>
      </button>
      <button
        type="button"
        aria-label={strings.workspace.closeWorkspace(w.name)}
        title={busy ? strings.grid.closeWhileCommitting : undefined}
        disabled={busy}
        onClick={onClose}
        className="mr-1 rounded-sm px-1.5 hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        ×
      </button>
    </li>
  );
}

export function WorkspaceSwitcher({ connectionsActive, onShowConnections, onSelectWorkspace }: Props) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeWorkspaceId);
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  const committing = usePendingChanges((s) => s.committing);
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
          // A running commit must finish before its workspace can close.
          const busy = w.tabs.some((t) => committing[t.id] === true);
          return (
            <SwitcherItem
              key={w.id}
              workspace={w}
              active={active}
              busy={busy}
              onSelect={() => onSelectWorkspace(w.id)}
              onClose={() => {
                // The workspace is already gone from the UI; a failed backend close
                // (e.g. a lost connection) has nothing left to report to.
                closeWorkspace(w.id).catch(() => {});
              }}
            />
          );
        })}
      </ul>
    </nav>
  );
}
