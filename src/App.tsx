import { useEffect, useRef, useState } from "react";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useFontShortcuts } from "./features/settings/useFontShortcuts";
import { useAction } from "./lib/keymap";
import { ConnectPrompt } from "./features/connections/ConnectPrompt";
import { ConnectionForm } from "./features/connections/ConnectionForm";
import { ImportDialog } from "./features/connections/ImportDialog";
import { ConnectionList } from "./features/connections/ConnectionList";
import { WelcomePane } from "./features/connections/WelcomePane";
import { flowTarget, useConnectFlow } from "./features/connections/useConnectFlow";
import { toAppError } from "./lib/errors";
import { AppToolbar } from "./features/chrome/AppToolbar";
import { ResizeHandles } from "./features/chrome/ResizeHandles";
import { TooltipLayer } from "./features/chrome/TooltipLayer";
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
  /** The row selected in the connection list. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The form shown on the connections screen in place of the list: a saved connection,
   * or null for a new one; no form shows the list.
   */
  const [form, setForm] = useState<{ connection: ConnectionConfig | null } | null>(null);
  const [importDialog, setImportDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const listSearch = useRef<HTMLInputElement>(null);
  /** Ctrl+Shift+K asked for the list: its search takes the focus once it is on screen. */
  const focusListSearch = useRef(false);
  const editForm = (cfg: ConnectionConfig | null) => {
    if (cfg) setSelectedId(cfg.id);
    setForm({ connection: cfg });
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
  // Spec §5.3 / §5.5: Ctrl+N a new connection's form, Ctrl+Shift+K the connection list,
  // from anywhere (a workspace included).
  useAction("connection.new", () => {
    editForm(null);
    setView("connections");
  });
  useAction("connection.open", () => {
    setForm(null);
    setView("connections");
    focusListSearch.current = true;
  });
  useEffect(() => {
    if (!focusListSearch.current || !listSearch.current) return;
    focusListSearch.current = false;
    listSearch.current.focus();
  });

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
      if (await openFlow.start(initial, cfg, flowTarget(cfg))) {
        setForm(null);
        setView("workspace");
      }
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
          editForm(cfg);
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
        ) : form ? (
          <main className="min-w-0 flex-1 overflow-y-auto bg-content">
            {loadError && <p className="mx-auto w-[620px] max-w-full px-5 pt-3 text-danger">{loadError}</p>}
            <ConnectionForm
              connection={form.connection}
              onSaved={(cfg) => editForm(cfg)}
              onDeleted={() => {
                setSelectedId(null);
                setForm(null);
              }}
              onConnect={open}
              onClose={() => setForm(null)}
            />
          </main>
        ) : (
          <>
            <WelcomePane onCreate={() => editForm(null)} onImport={() => setImportDialog(true)} />
            <main className="flex min-w-0 flex-1 flex-col">
              {loadError && <p className="bg-content px-4 py-2 text-danger">{loadError}</p>}
              <ConnectionList
                items={items}
                selectedId={selectedId}
                searchRef={listSearch}
                onSelect={(cfg) => setSelectedId(cfg.id)}
                onOpen={(cfg) => open(cfg)}
                onEdit={(cfg) => editForm(cfg)}
                onNew={() => editForm(null)}
              />
            </main>
          </>
        )}
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {importDialog && <ImportDialog onClose={() => setImportDialog(false)} />}
      <CloseConfirm />
      <CommandPalette
        onOpenConnection={(cfg) => void open(cfg)}
        onNewConnection={() => {
          editForm(null);
          setView("connections");
        }}
        onShowWorkspace={() => setView("workspace")}
      />
      <ConnectPrompt flow={openFlow} connectionName={openFlow.context?.name ?? ""} />
      <ResizeHandles />
      <TooltipLayer />
    </div>
  );
}

export default App;
