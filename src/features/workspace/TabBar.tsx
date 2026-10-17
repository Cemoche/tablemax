import { strings } from "../../lib/strings";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { TabList } from "./TabList";

export function TabBar({ workspace }: { workspace: Workspace }) {
  const activateTab = useWorkspaces((s) => s.activateTab);
  const closeTab = useWorkspaces((s) => s.closeTab);
  const pinTab = useWorkspaces((s) => s.pinTab);
  const openQueryTab = useWorkspaces((s) => s.openQueryTab);
  const { id } = workspace;
  return (
    <div className="flex items-stretch border-b border-border bg-surface">
      <div
        role="tablist"
        aria-label={strings.workspace.tabsLabel}
        className="flex min-w-0 flex-1 overflow-x-auto"
      >
        {workspace.tabs.map((t) => {
          const active = t.id === workspace.activeTabId;
          return (
            <div
              key={t.id}
              className={`flex shrink-0 items-center border-r border-border ${
                active ? "bg-bg text-fg" : "bg-surface text-muted hover:bg-surface-2"
              }`}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault(); // suppress autoscroll
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(id, t.id);
                }
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => activateTab(id, t.id)}
                onDoubleClick={() => pinTab(id, t.id)}
                className={`max-w-48 truncate py-1.5 pl-3 pr-1 ${active ? "font-semibold" : ""} ${
                  t.kind === "table" && t.preview ? "italic" : ""
                }`}
              >
                {t.title}
              </button>
              <button
                type="button"
                aria-label={strings.workspace.closeTab(t.title)}
                onClick={() => closeTab(id, t.id)}
                className="mr-1 rounded-sm px-1.5 hover:bg-surface-2"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label={strings.workspace.newQueryTab}
        title={strings.workspace.newQueryTab}
        onClick={() => openQueryTab(id)}
        className="shrink-0 px-3 hover:bg-surface-2"
      >
        +
      </button>
      <TabList workspace={workspace} />
    </div>
  );
}
