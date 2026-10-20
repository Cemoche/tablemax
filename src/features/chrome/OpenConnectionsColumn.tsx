import { Database, LayoutList, X } from "lucide-react";
import { useAction } from "../../lib/keymap";
import { strings } from "../../lib/strings";
import { useConnections } from "../../stores/connections";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { swatchClass } from "./swatch";

const C = strings.connectionsColumn;

const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent";

interface Props {
  /** True while the connections screen (not a workspace) is shown. */
  connectionsActive: boolean;
  onShowConnections: () => void;
  onSelectWorkspace: (id: string) => void;
}

interface TileProps {
  workspace: Workspace;
  current: boolean;
  busy: boolean;
  onSelect: () => void;
}

/** One open workspace: its database icon in the connection's live color, its name on two lines. */
function Tile({ workspace: w, current, busy, onSelect }: TileProps) {
  const color = useConnections((s) => s.items.find((c) => c.id === w.connectionId)?.color) ?? w.color;
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  return (
    <li className="group relative">
      <button
        type="button"
        data-workspace-tile=""
        aria-label={w.name}
        aria-current={current ? "true" : undefined}
        title={w.name}
        onClick={onSelect}
        className={`flex w-full flex-col items-center gap-1 rounded-lg px-1 pt-2 pb-1.5 ${focusRing} ${
          current ? "bg-sel" : "hover:bg-seg-sel"
        }`}
      >
        <span
          data-tile-icon=""
          aria-hidden
          className={`flex size-8 items-center justify-center rounded-lg ${swatchClass(color)}`}
        >
          <Database size={17} strokeWidth={1.6} />
        </span>
        <span className="line-clamp-2 w-full text-center text-xs leading-tight break-words text-text">
          {w.name}
        </span>
      </button>
      <button
        type="button"
        aria-label={C.close(w.name)}
        title={busy ? strings.grid.closeWhileCommitting : C.close(w.name)}
        disabled={busy}
        onClick={() => {
          // The workspace is already gone from the UI; a failed backend close (e.g. a lost
          // connection) has nothing left to report to.
          closeWorkspace(w.id).catch(() => {});
        }}
        className={`absolute top-0.5 right-0.5 flex size-4.5 items-center justify-center rounded-full bg-pill text-icon opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:text-icon-dim ${focusRing}`}
      >
        <X aria-hidden size={11} strokeWidth={2} />
      </button>
    </li>
  );
}

/**
 * The column of open connections on the far left (spec §2.3, 80 px): a tile per open
 * workspace and the Connections button. Ctrl+Shift+[ / ] (and Ctrl+Shift+PageUp /
 * PageDown) go to the previous / next workspace, wrapping around.
 */
export function OpenConnectionsColumn({ connectionsActive, onShowConnections, onSelectWorkspace }: Props) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeWorkspaceId);
  const committing = usePendingChanges((s) => s.committing);

  const cycle = (step: 1 | -1) => {
    const n = workspaces.length;
    if (n === 0) return;
    const at = connectionsActive ? -1 : workspaces.findIndex((w) => w.id === activeId);
    const next = at < 0 ? (step === 1 ? 0 : n - 1) : (at + step + n) % n;
    onSelectWorkspace(workspaces[next].id);
  };
  useAction("workspace.next", () => cycle(1));
  useAction("workspace.previous", () => cycle(-1));

  return (
    <nav
      aria-label={C.label}
      className="flex w-20 shrink-0 flex-col gap-1 overflow-y-auto border-r border-sep bg-win px-1.5 py-2"
    >
      <button
        type="button"
        aria-pressed={connectionsActive}
        title={C.connections}
        onClick={onShowConnections}
        className={`flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-text-2 aria-pressed:bg-sel aria-pressed:text-text hover:bg-seg-sel ${focusRing}`}
      >
        <LayoutList aria-hidden size={18} strokeWidth={1.6} />
        <span className="text-xs">{C.connections}</span>
      </button>
      <div aria-hidden className="mx-2 my-1 border-t border-sep" />
      <ul className="flex flex-col gap-1">
        {workspaces.map((w) => (
          <Tile
            key={w.id}
            workspace={w}
            current={!connectionsActive && w.id === activeId}
            // A running commit must finish before its workspace can close.
            busy={w.tabs.some((t) => committing[t.id] === true)}
            onSelect={() => onSelectWorkspace(w.id)}
          />
        ))}
      </ul>
    </nav>
  );
}
