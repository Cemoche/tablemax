import { useEffect } from "react";
import { isModKey } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { QueryTab } from "../editor/QueryTab";
import { TableDataTab } from "../grid/TableDataTab";
import { EnvBanner } from "./EnvBanner";
import { ENV_BORDER } from "./envClasses";
import { useLiveEnv } from "./useLiveEnv";
import { ObjectSidebar } from "./ObjectSidebar";
import { TabBar } from "./TabBar";

export function TabContent({ workspace, tab }: { workspace: Workspace; tab: Tab }) {
  if (tab.kind === "table") {
    return (
      <TableDataTab
        workspaceId={workspace.id}
        tabId={tab.id}
        object={tab.object}
        dialect={workspace.dialect}
      />
    );
  }
  return <QueryTab workspace={workspace} tab={tab} />;
}

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const openQueryTab = useWorkspaces((s) => s.openQueryTab);
  const closeTab = useWorkspaces((s) => s.closeTab);
  const { id, activeTabId } = workspace;
  const active = workspace.tabs.find((t) => t.id === activeTabId) ?? null;
  const liveEnv = useLiveEnv(workspace);

  // Mod+S (Ctrl, Cmd on macOS) commits the active table tab, unless a modal or the grid's
  // cell editor is open (the edit being typed is not pending yet).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
      if (active?.kind !== "table") return;
      e.preventDefault();
      if (document.querySelector('[aria-modal="true"]')) return;
      if (usePendingChanges.getState().editorOpen[active.id]) return;
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
    <div className="flex h-full min-h-0 flex-col">
      <EnvBanner workspace={workspace} />
      <div className={`flex min-h-0 flex-1 border-t-2 ${ENV_BORDER[liveEnv.envTag]}`}>
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
      </div>
    </div>
  );
}
