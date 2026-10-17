import { useEffect } from "react";
import { isModKey } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { QueryTab } from "../editor/QueryTab";
import { TableDataTab } from "../grid/TableDataTab";
import { ConfirmDialog } from "./ConfirmDialog";
import { ObjectSidebar } from "./ObjectSidebar";
import { TabBar } from "./TabBar";

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

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const openQueryTab = useWorkspaces((s) => s.openQueryTab);
  const closeTab = useWorkspaces((s) => s.closeTab);
  const closeRequest = useWorkspaces((s) => s.closeRequest);
  const confirmCloseTab = useWorkspaces((s) => s.confirmCloseTab);
  const cancelCloseTab = useWorkspaces((s) => s.cancelCloseTab);
  const { id, activeTabId } = workspace;
  const active = workspace.tabs.find((t) => t.id === activeTabId) ?? null;

  // Mod+S (Ctrl, Cmd on macOS) commits the active table tab, unless a modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
      if (active?.kind !== "table") return;
      e.preventDefault();
      if (document.querySelector('[aria-modal="true"]')) return;
      void usePendingChanges.getState().commit(active.id, id, active.object);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        e.preventDefault();
        openQueryTab(id);
      } else if (key === "w") {
        e.preventDefault();
        if (activeTabId) closeTab(id, activeTabId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, activeTabId, openQueryTab, closeTab]);

  return (
    <div className={`flex h-full min-h-0 border-t-2 ${ENV_BORDER[workspace.envTag]}`}>
      <ObjectSidebar workspace={workspace} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar workspace={workspace} />
        <div className="min-h-0 flex-1 overflow-auto">
          {active ? (
            <TabContent key={active.id} workspace={workspace} tab={active} />
          ) : (
            <div className="p-5">
              <p>{strings.workspace.noTabs}</p>
              <p className="text-muted">{strings.workspace.noTabsHint}</p>
            </div>
          )}
        </div>
      </div>
      {closeRequest?.wsId === id && (
        <ConfirmDialog
          title={strings.grid.discardTitle}
          message={strings.grid.discardConfirm(closeRequest.count)}
          confirmLabel={strings.grid.discardOk}
          cancelLabel={strings.grid.discardCancel}
          onConfirm={confirmCloseTab}
          onCancel={cancelCloseTab}
        />
      )}
    </div>
  );
}
