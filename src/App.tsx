import { useCallback, useEffect, useState } from "react";
import { ConnectionForm } from "./features/connections/ConnectionForm";
import { ConnectionList } from "./features/connections/ConnectionList";
import { PasswordPrompt } from "./features/connections/PasswordPrompt";
import { isPasswordRequired, toAppError } from "./lib/errors";
import { WorkspaceSwitcher } from "./features/workspace/WorkspaceSwitcher";
import { WorkspaceView } from "./features/workspace/WorkspaceView";
import type { ConnectionConfig } from "./lib/types";
import { useConnections } from "./stores/connections";
import { useWorkspaces } from "./stores/workspaces";

type View = "connections" | "workspace";

interface Pending {
  cfg: ConnectionConfig;
  error: string | null;
}

function App() {
  const items = useConnections((s) => s.items);
  const load = useConnections((s) => s.load);
  const [selected, setSelected] = useState<ConnectionConfig | null>(null);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaces((s) => s.activeWorkspaceId);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const setActiveWorkspace = useWorkspaces((s) => s.setActiveWorkspace);
  const [view, setView] = useState<View>("connections");
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const showWorkspace = view === "workspace" && activeWorkspace !== null;
  const [pending, setPending] = useState<Pending | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    load().catch((e) => setLoadError(toAppError(e).message));
  }, [load]);

  const open = useCallback(async (cfg: ConnectionConfig, password: string | null) => {
    try {
      await openWorkspace(cfg.id, password);
      setPending(null);
      setView("workspace");
    } catch (e) {
      const err = toAppError(e);
      if (isPasswordRequired(err)) {
        setPending({ cfg, error: password !== null ? err.message : null });
      } else {
        setPending(null);
        setLoadError(err.message);
      }
    }
  }, [openWorkspace]);

  const requestOpen = (cfg: ConnectionConfig) => {
    setLoadError(null);
    // Already open: just activate it, never re-prompt for a password.
    if (workspaces.some((w) => w.connectionId === cfg.id)) return open(cfg, null);
    return cfg.passwordMode === "ask" ? setPending({ cfg, error: null }) : open(cfg, null);
  };

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      {workspaces.length > 0 && (
        <WorkspaceSwitcher
          connectionsActive={!showWorkspace}
          onShowConnections={() => setView("connections")}
          onSelectWorkspace={(id) => {
            setActiveWorkspace(id);
            setView("workspace");
          }}
        />
      )}
      <div className="flex min-h-0 flex-1">
        {showWorkspace ? (
          <main className="min-w-0 flex-1">
            <WorkspaceView key={activeWorkspace.id} workspace={activeWorkspace} />
          </main>
        ) : (
          <>
            <ConnectionList
              items={items}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              onOpen={requestOpen}
              onNew={() => setSelected(null)}
            />
            <main className="min-w-0 flex-1 overflow-y-auto">
              {loadError && <p className="p-3 text-danger">{loadError}</p>}
              <ConnectionForm
                connection={selected}
                onSaved={setSelected}
                onDeleted={() => setSelected(null)}
                onConnect={(cfg, pw) =>
                  cfg.passwordMode === "ask" || workspaces.some((w) => w.connectionId === cfg.id)
                    ? requestOpen(cfg)
                    : open(cfg, pw)
                }
              />
            </main>
          </>
        )}
      </div>
      {pending && (
        <PasswordPrompt
          connectionName={pending.cfg.name}
          error={pending.error}
          onSubmit={(pw) => open(pending.cfg, pw)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

export default App;
