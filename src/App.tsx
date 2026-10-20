import { useEffect, useRef, useState } from "react";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useFontShortcuts } from "./features/settings/useFontShortcuts";
import { useAction } from "./lib/keymap";
import { ConnectPrompt } from "./features/connections/ConnectPrompt";
import { ConnectionForm } from "./features/connections/ConnectionForm";
import { ImportDialog } from "./features/connections/ImportDialog";
import { UrlImportDialog } from "./features/connections/UrlImportDialog";
import { blankConnection } from "./features/connections/connectionDraft";
import { ConnectionList } from "./features/connections/ConnectionList";
import { flowTarget, useConnectFlow } from "./features/connections/useConnectFlow";
import { toAppError } from "./lib/errors";
import { AppToolbar } from "./features/chrome/AppToolbar";
import { ResizeHandles } from "./features/chrome/ResizeHandles";
import { CommandPalette } from "./features/palette/CommandPalette";
import { useWindowTitle } from "./features/workspace/useWindowTitle";
import { OpenConnectionsColumn } from "./features/chrome/OpenConnectionsColumn";
import { useChrome, useOnRequest } from "./stores/chrome";
import { CloseConfirm } from "./features/workspace/CloseConfirm";
import { WorkspaceView } from "./features/workspace/WorkspaceView";
import type { ConnectionConfig } from "./lib/types";
import { useConnections } from "./stores/connections";
import { restoreSession, startSessionAutosave } from "./stores/session";
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
  /** Why the last connect of a disconnected (restored) workspace failed. */
  const [connectError, setConnectError] = useState<{ connectionId: string; message: string } | null>(
    null,
  );
  const connectRequest = useWorkspaces((s) => s.connectRequest);
  /** Connection of the workspace on screen (null on the connections view), read when a connect fails. */
  const shownConnection = useRef<string | null>(null);
  shownConnection.current = showWorkspace ? activeWorkspace.connectionId : null;
  // Each open is bound to its connection; a newer open supersedes a pending one.
  const openFlow = useConnectFlow(async (s, cfg: ConnectionConfig) => {
    await openWorkspace(cfg.id, s.password, s.sshSecret, s.acceptFingerprint);
    return true;
  });

  // Mod+, opens the settings (a modifier combo, so it is fine while typing; not over a modal).
  useAction("settings.open", () => setSettingsOpen(true));
  // The gears of the toolbar (connections screen) and of the sidebar footer.
  useOnRequest(
    useChrome((s) => s.settingsRequest),
    () => setSettingsOpen(true),
  );
  useFontShortcuts();

  // Connections first (a restored workspace takes its name and color from its
  // connection), then the last session, disconnected: nothing connects at startup.
  // Without the connections the session is neither restored nor overwritten.
  useEffect(() => {
    let live = true;
    const stopAutosave = startSessionAutosave();
    load().then(
      async () => {
        await restoreSession();
        if (live && useWorkspaces.getState().activeWorkspaceId) setView("workspace");
      },
      (e) => setLoadError(toAppError(e).message),
    );
    return () => {
      live = false;
      stopAutosave();
    };
  }, [load]);

  // An already open workspace is just activated (openWorkspace never prompts for it);
  // otherwise missing secrets and unknown host keys are asked for by the flow.
  const open = async (
    cfg: ConnectionConfig,
    password: string | null = null,
    sshSecret: string | null = null,
  ) => {
    setLoadError(null);
    setConnectError(null);
    try {
      const initial = { password, sshSecret, acceptFingerprint: null };
      if (await openFlow.start(initial, cfg, flowTarget(cfg))) setView("workspace");
    } catch (e) {
      const message = toAppError(e).message;
      // A restored workspace stays in place, disconnected: its view shows the error.
      // Started from the connections view (list, form), the error shows there too.
      const ws = useWorkspaces.getState().workspaces.find((w) => w.connectionId === cfg.id);
      const disconnected = ws !== undefined && ws.status !== "connected";
      if (disconnected) setConnectError({ connectionId: cfg.id, message });
      if (!disconnected || shownConnection.current !== cfg.id) setLoadError(message);
    }
  };

  // Activating a disconnected workspace (one of its tabs, the workspace itself or its
  // Reconnect button) runs the same flow as opening it, prompts included.
  useEffect(() => {
    if (!connectRequest) return;
    useWorkspaces.getState().clearConnectRequest();
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === connectRequest.workspaceId);
    const cfg = ws && useConnections.getState().items.find((c) => c.id === ws.connectionId);
    if (cfg) void open(cfg);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per request
  }, [connectRequest]);

  const shownConnectError =
    showWorkspace && connectError?.connectionId === activeWorkspace.connectionId ? connectError.message : null;

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <AppToolbar
        workspace={showWorkspace ? activeWorkspace : null}
        connectError={shownConnectError}
        onEditConnection={(cfg) => {
          select(cfg);
          setView("connections");
        }}
      />
      <div className="flex min-h-0 flex-1">
        {workspaces.length > 0 && (
          <OpenConnectionsColumn
            connectionsActive={!showWorkspace}
            onShowConnections={() => setView("connections")}
            onSelectWorkspace={(id) => {
              setActiveWorkspace(id);
              setView("workspace");
            }}
          />
        )}
        {showWorkspace ? (
          <main className="min-w-0 flex-1">
            <WorkspaceView
              key={activeWorkspace.id}
              workspace={activeWorkspace}
              connectError={shownConnectError}
            />
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
      <CommandPalette
        onOpenConnection={(cfg) => void open(cfg)}
        onNewConnection={() => {
          select(null);
          setView("connections");
        }}
        onShowWorkspace={() => setView("workspace")}
      />
      <ConnectPrompt flow={openFlow} connectionName={openFlow.context?.name ?? ""} />
      <ResizeHandles />
    </div>
  );
}

export default App;
