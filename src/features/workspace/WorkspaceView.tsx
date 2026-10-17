import { useShortcut } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { QueryTab } from "../editor/QueryTab";
import { TableDataTab } from "../grid/TableDataTab";
import { ObjectSidebar } from "./ObjectSidebar";
import { TabBar } from "./TabBar";
import { TabSwitcher } from "./TabSwitcher";

const ENV_BORDER = {
  local: "border-t-env-local",
  dev: "border-t-env-dev",
  staging: "border-t-env-staging",
  prod: "border-t-env-prod",
} as const;

export function TabContent({ workspace, tab }: { workspace: Workspace; tab: Tab }) {
  if (tab.kind === "table") {
    return <TableDataTab workspaceId={workspace.id} tabId={tab.id} object={tab.object} />;
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
  // A restored workspace has a placeholder id until it connects: nothing below may
  // reach the backend with it.
  const connected = workspace.status === "connected";

  useShortcut("Mod+T", () => openQueryTab(id));
  useShortcut("Mod+W", () => {
    if (activeTabId) closeTab(id, activeTabId);
  });

  const active = workspace.tabs.find((t) => t.id === activeTabId) ?? null;
  return (
    <div className={`flex h-full min-h-0 border-t-2 ${ENV_BORDER[workspace.envTag]}`}>
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
              <p className="text-muted">{strings.workspace.noTabsHint}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
