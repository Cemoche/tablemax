import { useAction, useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Tab, type Workspace, capabilitiesOf, sqlDialect, useWorkspaces } from "../../stores/workspaces";
import { QueryTab } from "../editor/QueryTab";
import { TableDataTab } from "../grid/TableDataTab";
import { ObjectSidebar } from "./ObjectSidebar";
import { TabBar } from "./TabBar";
import { TabSwitcher } from "./TabSwitcher";

export function TabContent({ workspace, tab }: { workspace: Workspace; tab: Tab }) {
  if (tab.kind === "table") {
    return (
      <TableDataTab
        workspaceId={workspace.id}
        tabId={tab.id}
        object={tab.object}
        dialect={sqlDialect(workspace)}
      />
    );
  }
  return <QueryTab workspace={workspace} tab={tab} />;
}

/** In place of the tab content while the workspace has no backend connection. */
function Disconnected({ workspace, error }: { workspace: Workspace; error: string | null }) {
  const requestConnect = useWorkspaces((s) => s.requestConnect);
  if (workspace.status === "connecting") {
    return <p className="p-5 text-muted">{strings.session.connecting}</p>;
  }
  return (
    <div className="flex flex-col items-start gap-2 p-5">
      <p className="font-semibold">{strings.session.disconnected}</p>
      <p className="text-muted">{strings.session.disconnectedHint}</p>
      {error && <p className="text-danger">{error}</p>}
      <button
        type="button"
        onClick={() => requestConnect(workspace.id)}
        className="rounded-sm border border-border px-3 py-1 hover:bg-surface-2"
      >
        {strings.session.reconnect}
      </button>
    </div>
  );
}

interface Props {
  workspace: Workspace;
  /** Why the last connect of this (disconnected) workspace failed. */
  connectError?: string | null;
}

export function WorkspaceView({ workspace, connectError = null }: Props) {
  const openQueryTab = useWorkspaces((s) => s.openQueryTab);
  const closeTab = useWorkspaces((s) => s.closeTab);
  const sidebarVisible = useWorkspaces((s) => s.sidebarVisible);
  const dismissNotice = useWorkspaces((s) => s.dismissNotice);
  const { id, activeTabId } = workspace;
  const active = workspace.tabs.find((t) => t.id === activeTabId) ?? null;
  const newTabShortcut = useEffectiveShortcut("query.new");
  const { sqlEditor } = capabilitiesOf(workspace);

  // A restored workspace has a placeholder id until it connects: nothing below may
  // reach the backend with it.
  const connected = workspace.status === "connected";

  useAction("query.new", () => {
    if (sqlEditor) openQueryTab(id);
  });
  // Ctrl+E (TablePlus ⌘E): the SQL editor, in a new SQL tab like the toolbar's SQL button.
  useAction("editor.open", () => {
    if (sqlEditor) openQueryTab(id);
  });
  useAction("tab.close", () => {
    if (activeTabId) closeTab(id, activeTabId);
  });
  // Mod+S commits the active table tab (a SQL tab binds Mod+S to save the query), unless
  // a modal (useAction) or the grid's cell editor is open: the edit being typed is not
  // pending yet. A restored workspace's placeholder id must not reach the backend.
  useAction("grid.commit", () => {
    if (!connected || active?.kind !== "table") return;
    if (usePendingChanges.getState().editorOpen[active.id]) return;
    void usePendingChanges.getState().commit(active.id, id, active.object);
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {connected && sidebarVisible && <ObjectSidebar workspace={workspace} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar workspace={workspace} />
          {workspace.notice && (
            <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1 text-sm">
              <span role="status" className="min-w-0 flex-1 text-warning">
                {workspace.notice}
              </span>
              <button
                type="button"
                onClick={() => dismissNotice(id)}
                className="shrink-0 rounded-sm border border-border px-2 py-0.5 hover:bg-surface-2"
              >
                {strings.workspace.dismissNotice}
              </button>
            </div>
          )}
          <TabSwitcher workspace={workspace} />
          <div
            data-tab-content=""
            tabIndex={-1}
            aria-label={strings.workspace.tabContentLabel}
            className="min-h-0 flex-1 overflow-auto outline-none"
          >
            {!connected ? (
              <Disconnected workspace={workspace} error={connectError} />
            ) : active ? (
              <TabContent key={active.id} workspace={workspace} tab={active} />
            ) : (
              <div className="p-5">
                <p>{strings.workspace.noTabs}</p>
                {sqlEditor && (
                  <p className="text-muted">{strings.workspace.noTabsHint(formatShortcut(newTabShortcut))}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
