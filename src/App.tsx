import { useEffect, useState } from "react";
import { ConnectPrompt } from "./features/connections/ConnectPrompt";
import { ConnectionForm } from "./features/connections/ConnectionForm";
import { ConnectionList } from "./features/connections/ConnectionList";
import { hostKeyLabel, useConnectFlow } from "./features/connections/useConnectFlow";
import { toAppError } from "./lib/errors";
import { WorkspaceSwitcher } from "./features/workspace/WorkspaceSwitcher";
import { WorkspaceView } from "./features/workspace/WorkspaceView";
import type { ConnectionConfig } from "./lib/types";
import { useConnections } from "./stores/connections";
import { useWorkspaces } from "./stores/workspaces";

type View = "connections" | "workspace";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  // Each open is bound to its connection; a newer open supersedes a pending one.
  const openFlow = useConnectFlow(async (s, cfg: ConnectionConfig) => {
    await openWorkspace(cfg.id, s.password, s.sshSecret, s.acceptFingerprint);
    return true;
  });

  useEffect(() => {
    load().catch((e) => setLoadError(toAppError(e).message));
  }, [load]);

  // An already open workspace is just activated (openWorkspace never prompts for it);
  // otherwise missing secrets and unknown host keys are asked for by the flow.
  const open = async (
    cfg: ConnectionConfig,
    password: string | null = null,
    sshSecret: string | null = null,
  ) => {
    setLoadError(null);
    try {
      const initial = { password, sshSecret, acceptFingerprint: null };
      if (await openFlow.start(initial, cfg, hostKeyLabel(cfg))) setView("workspace");
    } catch (e) {
      setLoadError(toAppError(e).message);
    }
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
              onOpen={(cfg) => open(cfg)}
              onNew={() => setSelected(null)}
            />
            <main className="min-w-0 flex-1 overflow-y-auto">
              {loadError && <p className="p-3 text-danger">{loadError}</p>}
              <ConnectionForm
                connection={selected}
                onSaved={setSelected}
                onDeleted={() => setSelected(null)}
                onConnect={open}
              />
            </main>
          </>
        )}
      </div>
      <ConnectPrompt flow={openFlow} connectionName={openFlow.context?.name ?? ""} />
    </div>
  );
}

export default App;
