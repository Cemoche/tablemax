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
import { sqliteFileDraft } from "./features/connections/connectionDraft";
import { toAppError } from "./lib/errors";
import * as ipc from "./lib/ipc";
import { AppToolbar } from "./features/chrome/AppToolbar";
import { ResizeHandles } from "./features/chrome/ResizeHandles";
import { TooltipLayer } from "./features/chrome/TooltipLayer";
import { CommandPalette } from "./features/palette/CommandPalette";
import { useWindowTitle } from "./features/workspace/useWindowTitle";
import { OpenConnectionsColumn } from "./features/chrome/OpenConnectionsColumn";
import { useChrome, useOnRequest } from "./stores/chrome";
import { CloseConfirm } from "./features/workspace/CloseConfirm";
import { ConfirmDialog } from "./features/workspace/ConfirmDialog";
import { WorkspaceView } from "./features/workspace/WorkspaceView";
import { strings } from "./lib/strings";
import type { ConnectionConfig } from "./lib/types";
import { useConnections } from "./stores/connections";
import { restoreSession, startSessionAutosave } from "./stores/session";
import { useWorkspaces } from "./stores/workspaces";

type View = "connections" | "workspace";

function App() {
  const items = useConnections((s) => s.items);
  const load = useConnections((s) => s.load);
  const [view, setView] = useState<View>("connections");
  /** The row selected in the connection list. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The form shown on the connections screen in place of the list: a saved connection,
   * or null for a new one (`draft`: its starting values, Open SQLite file…); no form shows
   * the list. `seq` remounts the form for each new opening (fresh state, focus on its
   * first field), not after a save.
   */
  const [form, setForm] = useState<{
    connection: ConnectionConfig | null;
    draft?: ConnectionConfig;
    seq: number;
  } | null>(null);
  const formSeq = useRef(0);
  /** The open form holds unsaved edits (ConnectionForm's onDirtyChange). */
  const formDirty = useRef(false);
  /** An action that would drop the form's unsaved edits, waiting for Discard. */
  const [discardAsk, setDiscardAsk] = useState<{ run: () => void; name: string; focus: Element | null } | null>(
    null,
  );
  const [importDialog, setImportDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const listSearch = useRef<HTMLInputElement>(null);
  /** Where the focus goes once the list is back on screen: its search, or the selected row. */
  const pendingFocus = useRef<"search" | "row" | null>(null);
  /** Runs `action`, which drops the open form, at once, or after Discard if it has unsaved edits. */
  const unlessDirty = (action: () => void) => {
    if (form && formDirty.current) {
      setDiscardAsk({ run: action, name: form.connection?.name ?? "", focus: document.activeElement });
    } else action();
  };
  const dropForm = () => {
    formDirty.current = false;
    setForm(null);
  };
  /** A fresh form on the connections screen (null: a new connection); the same connection's form stays. */
  const showForm = (cfg: ConnectionConfig | null) => {
    if (cfg && form?.connection?.id === cfg.id) {
      setView("connections");
      return;
    }
    unlessDirty(() => {
      if (cfg) setSelectedId(cfg.id);
      formDirty.current = false;
      formSeq.current += 1;
      setForm({ connection: cfg, seq: formSeq.current });
      setView("connections");
    });
  };
  /**
   * Open SQLite file… (welcome pane, palette; #117): the SQLite file picker, then a new
   * connection's form on the chosen file, unsaved — Connect saves and opens it, like any
   * new connection; nothing is written before. Cancelling the picker changes nothing; a
   * picker failure shows on the connections screen. A form with edits is asked about first.
   */
  const openSqliteFile = () =>
    unlessDirty(async () => {
      let path: string | null;
      try {
        path = await ipc.filePick("sqlite");
      } catch (e) {
        setLoadError(toAppError(e).message);
        return;
      }
      if (path === null) return;
      setLoadError(null);
      formDirty.current = false;
      formSeq.current += 1;
      setForm({ connection: null, draft: sqliteFileDraft(path), seq: formSeq.current });
      setView("connections");
    });
  /** The form's back button: the list, the focus on the selected row (else the search). */
  const closeForm = () =>
    unlessDirty(() => {
      dropForm();
      pendingFocus.current = "row";
    });
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaces((s) => s.activeWorkspaceId);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const setActiveWorkspace = useWorkspaces((s) => s.setActiveWorkspace);
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
  useAction("connection.new", () => showForm(null));
  /** Ctrl+Shift+K and the palette's Show connections: the list, its search focused. */
  const showConnections = () =>
    unlessDirty(() => {
      dropForm();
      setView("connections");
      // The list already on screen takes the focus now; otherwise once it is rendered.
      if (listSearch.current) listSearch.current.focus();
      else pendingFocus.current = "search";
    });
  useAction("connection.open", showConnections);
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want || !listSearch.current) return;
    pendingFocus.current = null;
    const row = want === "row" ? document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') : null;
    (row ?? listSearch.current).focus();
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
        // A form with unsaved edits (another connection opened from the palette) stays
        // for when the user comes back to the connections screen.
        if (!formDirty.current) setForm(null);
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
        onEditConnection={(cfg) => showForm(cfg)}
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
        ) : form ? null : (
          <>
            <WelcomePane
              onCreate={() => showForm(null)}
              onImport={() => setImportDialog(true)}
              onOpenSqlite={openSqliteFile}
            />
            <main className="flex min-w-0 flex-1 flex-col">
              {loadError && <p className="bg-content px-4 py-2 text-danger-text">{loadError}</p>}
              <ConnectionList
                items={items}
                selectedId={selectedId}
                searchRef={listSearch}
                onSelect={(cfg) => setSelectedId(cfg.id)}
                onOpen={(cfg) => open(cfg)}
                onEdit={(cfg) => showForm(cfg)}
                onNew={() => showForm(null)}
              />
            </main>
          </>
        )}
        {/* The form stays mounted (hidden) behind a workspace: its unsaved edits wait there. */}
        {form && (
          <main hidden={showWorkspace} className="min-w-0 flex-1 overflow-y-auto bg-content">
            {loadError && <p className="mx-auto w-[620px] max-w-full px-5 pt-3 text-danger-text">{loadError}</p>}
            <ConnectionForm
              key={form.seq}
              connection={form.connection}
              draft={form.draft}
              active={!showWorkspace}
              onDirtyChange={(dirty) => {
                formDirty.current = dirty;
              }}
              onSaved={(cfg) => {
                // Clean at once: open() reads the flag right after a Connect's save.
                formDirty.current = false;
                setSelectedId(cfg.id);
                setForm((f) => f && { ...f, connection: cfg });
              }}
              onDeleted={() => {
                setSelectedId(null);
                dropForm();
                pendingFocus.current = "search";
              }}
              onConnect={open}
              onClose={closeForm}
            />
          </main>
        )}
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {importDialog && <ImportDialog onClose={() => setImportDialog(false)} />}
      <CloseConfirm />
      {discardAsk && (
        <ConfirmDialog
          title={strings.connections.discardTitle}
          message={strings.connections.discardMessage(discardAsk.name)}
          confirmLabel={strings.connections.discardOk}
          cancelLabel={strings.connections.discardCancel}
          onConfirm={() => {
            setDiscardAsk(null);
            discardAsk.run();
          }}
          onCancel={() => {
            setDiscardAsk(null);
            if (discardAsk.focus instanceof HTMLElement) discardAsk.focus.focus();
          }}
        />
      )}
      <CommandPalette
        onOpenConnection={(cfg) => void open(cfg)}
        onNewConnection={() => showForm(null)}
        onShowConnections={showConnections}
        onOpenSqliteFile={openSqliteFile}
        onShowWorkspace={() => setView("workspace")}
      />
      <ConnectPrompt flow={openFlow} connectionName={openFlow.context?.name ?? ""} />
      <ResizeHandles />
      <TooltipLayer />
    </div>
  );
}

export default App;
