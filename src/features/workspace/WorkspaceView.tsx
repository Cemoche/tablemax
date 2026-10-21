import { type KeymapActionId, alternateShortcuts, useAction, useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { useShortcut } from "../../lib/shortcuts";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { useSettings } from "../../stores/settings";
import { type Tab, type Workspace, capabilitiesOf, sqlDialect, useWorkspaces } from "../../stores/workspaces";
import { QueryTab } from "../editor/QueryTab";
import { TableDataTab } from "../grid/TableDataTab";
import { Sidebar, useSidebarShortcuts } from "../sidebar/Sidebar";
import { TabBar } from "./TabBar";
import { TabSwitcher } from "./TabSwitcher";
import { tabDomId, tabPanelDomId } from "./tabDom";
import { useNavigationShortcuts } from "./navigation";

/**
 * The tab keys of a workspace that move in tab bar order (spec §5.3): the alternates of
 * `tab.next` / `tab.previous` (Mod+] / Mod+[, Mod+PageDown / Mod+PageUp; their main
 * combinations, Ctrl+Tab, keep the most-recent order in TabSwitcher), and `tab.goto1`…`9`.
 * They also act in the SQL editor, whose own Mod+[ / Mod+] are dropped (SqlEditor).
 */
function useTabShortcuts(wsId: string) {
  const cycleTab = useWorkspaces((s) => s.cycleTab);
  const nextAlt = useSettings((s) => alternateShortcuts("tab.next", s.settings.keymap).join("\n"));
  const prevAlt = useSettings((s) => alternateShortcuts("tab.previous", s.settings.keymap).join("\n"));
  useShortcut(nextAlt.split("\n"), () => cycleTab(wsId, 1), { enabled: nextAlt !== "" });
  useShortcut(prevAlt.split("\n"), () => cycleTab(wsId, -1), { enabled: prevAlt !== "" });
  useGotoTab(wsId, 1);
  useGotoTab(wsId, 2);
  useGotoTab(wsId, 3);
  useGotoTab(wsId, 4);
  useGotoTab(wsId, 5);
  useGotoTab(wsId, 6);
  useGotoTab(wsId, 7);
  useGotoTab(wsId, 8);
  useGotoTab(wsId, 9);
}

/** `tab.goto<n>` (Mod+n) activates the n-th tab; nothing when there are fewer tabs. */
function useGotoTab(wsId: string, n: number) {
  const activateTabAt = useWorkspaces((s) => s.activateTabAt);
  useAction(`tab.goto${n}` as KeymapActionId, () => activateTabAt(wsId, n - 1));
}

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

  useSidebarShortcuts(id, connected);
  useTabShortcuts(id);
  useNavigationShortcuts(id, true);
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
        {connected && sidebarVisible && <Sidebar workspace={workspace} />}
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
          {/* The active tab's panel, named by the tab (aria-labelledby wins over aria-label). */}
          <div
            data-tab-content=""
            tabIndex={-1}
            id={tabPanelDomId(id)}
            role={active ? "tabpanel" : undefined}
            aria-labelledby={active ? tabDomId(id, active.id) : undefined}
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
