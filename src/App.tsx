import { useEffect, useState } from "react";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { strings } from "./lib/strings";
import { ConnectPrompt } from "./features/connections/ConnectPrompt";
import { ConnectionForm } from "./features/connections/ConnectionForm";
import { ImportDialog } from "./features/connections/ImportDialog";
import { UrlImportDialog } from "./features/connections/UrlImportDialog";
import { blankConnection } from "./features/connections/connectionDraft";
import { ConnectionList } from "./features/connections/ConnectionList";
import { flowTarget, useConnectFlow } from "./features/connections/useConnectFlow";
import { toAppError } from "./lib/errors";
import { useWindowTitle } from "./features/workspace/useWindowTitle";
import { WorkspaceSwitcher } from "./features/workspace/WorkspaceSwitcher";
import { CloseConfirm } from "./features/workspace/CloseConfirm";
import { WorkspaceView } from "./features/workspace/WorkspaceView";
import type { ConnectionConfig } from "./lib/types";
import { useConnections } from "./stores/connections";
import { useWorkspaces } from "./stores/workspaces";

type View = "connections" | "workspace";

function App() {
  const items = useConnections((s) => s.items);
  const load = useConnections((s) => s.load);
  const [selected, setSelected] = useState<ConnectionConfig | null>(null);
  /** DB password pasted in a URL, pre-filled in the form of the unsaved connection. */
  const [draftPassword, setDraftPassword] = useState<string | null>(null);
  const [draftSslExplicit, setDraftSslExplicit] = useState(false);
  const [urlDialog, setUrlDialog] = useState(false);
  const [importDialog, setImportDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const select = (cfg: ConnectionConfig | null, password: string | null = null, sslExplicit = false) => {
    setSelected(cfg);
    setDraftPassword(password);
    setDraftSslExplicit(sslExplicit);
  };
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaces((s) => s.activeWorkspaceId);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const setActiveWorkspace = useWorkspaces((s) => s.setActiveWorkspace);
  const [view, setView] = useState<View>("connections");
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const showWorkspace = view === "workspace" && activeWorkspace !== null;
  useWindowTitle(showWorkspace ? activeWorkspace : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Each open is bound to its connection; a newer open supersedes a pending one.
  const openFlow = useConnectFlow(async (s, cfg: ConnectionConfig) => {
    await openWorkspace(cfg.id, s.password, s.sshSecret, s.acceptFingerprint);
    return true;
  });

  // Mod+, opens the settings (a modifier combo, so it is fine while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      if (await openFlow.start(initial, cfg, flowTarget(cfg))) setView("workspace");
    } catch (e) {
      setLoadError(toAppError(e).message);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <div className="flex items-stretch border-b border-border bg-surface">
        <div className="min-w-0 flex-1">
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
        </div>
        <button
          type="button"
          aria-label={strings.settings.open}
          title={strings.settings.open}
          onClick={() => setSettingsOpen(true)}
          className="shrink-0 px-3 py-1.5 hover:bg-surface-2"
        >
          <span aria-hidden>⚙</span>
        </button>
      </div>
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
              onSelect={(cfg) => select(cfg)}
              onOpen={(cfg) => open(cfg)}
              onNew={() => select(null)}
              onNewFromUrl={() => setUrlDialog(true)}
              onImport={() => setImportDialog(true)}
            />
            <main className="min-w-0 flex-1 overflow-y-auto">
              {loadError && <p className="p-3 text-danger">{loadError}</p>}
              <ConnectionForm
                connection={selected}
                initialPassword={draftPassword}
                sslExplicit={draftSslExplicit}
                onSaved={(cfg) => select(cfg)}
                onDeleted={() => select(null)}
                onConnect={open}
              />
            </main>
          </>
        )}
      </div>
      {urlDialog && (
        <UrlImportDialog
          onCancel={() => setUrlDialog(false)}
          onResult={(config, password, sslExplicit) => {
            const draft = { ...blankConnection(), ...config };
            const fallback =
              draft.kind === "sqlite"
                ? (draft.sqlitePath?.split("/").pop() ?? "")
                : (draft.database ?? draft.host);
            select({ ...draft, name: fallback }, password, sslExplicit);
            setUrlDialog(false);
          }}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {importDialog && <ImportDialog onClose={() => setImportDialog(false)} />}
      <CloseConfirm />
      <ConnectPrompt flow={openFlow} connectionName={openFlow.context?.name ?? ""} />
    </div>
  );
}

export default App;
