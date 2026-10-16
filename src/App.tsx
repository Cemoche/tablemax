import { useCallback, useEffect, useState } from "react";
import { ConnectionForm } from "./features/connections/ConnectionForm";
import { ConnectionList } from "./features/connections/ConnectionList";
import { PasswordPrompt } from "./features/connections/PasswordPrompt";
import { isPasswordRequired, toAppError } from "./lib/errors";
import * as ipc from "./lib/ipc";
import { strings } from "./lib/strings";
import type { ConnectionConfig, WorkspaceInfo } from "./lib/types";
import { useConnections } from "./stores/connections";

/** "connections" shows the form; Task 9 renders a workspace when `view` is a workspace. */
type View = "connections" | { workspace: WorkspaceInfo; name: string };

interface Pending {
  cfg: ConnectionConfig;
  error: string | null;
}

function App() {
  const items = useConnections((s) => s.items);
  const load = useConnections((s) => s.load);
  const [selected, setSelected] = useState<ConnectionConfig | null>(null);
  const [view, setView] = useState<View>("connections");
  const [pending, setPending] = useState<Pending | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    load().catch((e) => setLoadError(toAppError(e).message));
  }, [load]);

  const open = useCallback(async (cfg: ConnectionConfig, password: string | null) => {
    try {
      const ws = await ipc.workspaceOpen(cfg.id, password);
      setPending(null);
      setView({ workspace: ws, name: cfg.name });
    } catch (e) {
      const err = toAppError(e);
      if (isPasswordRequired(err)) {
        setPending({ cfg, error: password !== null ? err.message : null });
      } else {
        setPending(null);
        setLoadError(err.message);
      }
    }
  }, []);

  const requestOpen = (cfg: ConnectionConfig) => {
    setLoadError(null);
    return cfg.passwordMode === "ask" ? setPending({ cfg, error: null }) : open(cfg, null);
  };

  return (
    <div className="flex h-screen bg-bg text-fg">
      <ConnectionList
        items={items}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        onOpen={requestOpen}
        onNew={() => {
          setSelected(null);
          setView("connections");
        }}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">
        {loadError && <p className="p-3 text-danger">{loadError}</p>}
        {view === "connections" ? (
          <ConnectionForm
            connection={selected}
            onSaved={setSelected}
            onDeleted={() => setSelected(null)}
            onConnect={(cfg, pw) => (cfg.passwordMode === "ask" ? requestOpen(cfg) : open(cfg, pw))}
          />
        ) : (
          <div className="p-5">
            <p>{strings.workspace.opened(view.name)}</p>
            <p className="text-muted">{strings.workspace.placeholder}</p>
            <button
              type="button"
              className="mt-3 rounded-sm border border-border px-3 py-1"
              onClick={() => {
                void ipc.workspaceClose(view.workspace.workspaceId);
                setView("connections");
              }}
            >
              {strings.workspace.back}
            </button>
          </div>
        )}
      </main>
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
