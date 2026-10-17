import { strings } from "../../lib/strings";
import { type Tab, type Workspace, useWorkspaces } from "../../stores/workspaces";
import { useCatalog } from "../../stores/catalog";
import { useQueryPanels } from "../../stores/queryPanels";
import { hasEditorCommand, runEditorCommand } from "../editor/editorCommands";
import { tabsByMru } from "../workspace/tabInfo";

/** What an action can see and do: the active workspace and tab, plus palette callbacks. */
export interface ActionCtx {
  workspace: Workspace | null;
  tab: Tab | null;
  /** Shows the new-connection form (App). */
  newConnection: () => void;
  /** Switch the palette to the schema / database sub-list (it stays open). */
  pickSchema: () => void;
  pickDatabase: () => void;
}

export interface Action {
  id: string;
  title: string;
  /** Spec in `matchShortcut` syntax ("Mod+T"); shown human-readable. */
  shortcut?: string;
  /** Hidden when it returns false (default: always available). */
  when?: (ctx: ActionCtx) => boolean;
  run: (ctx: ActionCtx) => void;
}

const t = strings.palette.action;
const connected = (c: ActionCtx) => c.workspace?.status === "connected";
const queryTab = (c: ActionCtx) => (c.tab?.kind === "query" ? c.tab : null);

/** Tabs other than the active one, in MRU order. */
function others(c: ActionCtx): Tab[] {
  return c.workspace ? tabsByMru(c.workspace).filter((x) => x.id !== c.workspace?.activeTabId) : [];
}

export const ACTIONS: Action[] = [
  {
    id: "query.new",
    title: t.newQuery,
    shortcut: "Mod+T",
    when: (c) => c.workspace !== null,
    run: (c) => c.workspace && useWorkspaces.getState().openQueryTab(c.workspace.id),
  },
  {
    id: "tab.close",
    title: t.closeTab,
    shortcut: "Mod+W",
    when: (c) => c.workspace !== null && c.workspace.activeTabId !== null,
    run: (c) => {
      if (c.workspace?.activeTabId) useWorkspaces.getState().closeTab(c.workspace.id, c.workspace.activeTabId);
    },
  },
  {
    id: "tab.next",
    title: t.nextTab,
    shortcut: "Ctrl+Tab",
    when: (c) => others(c).length > 0,
    run: (c) => {
      const to = others(c)[0];
      if (c.workspace && to) useWorkspaces.getState().activateTab(c.workspace.id, to.id);
    },
  },
  {
    id: "tab.previous",
    title: t.previousTab,
    shortcut: "Ctrl+Shift+Tab",
    when: (c) => others(c).length > 0,
    run: (c) => {
      const to = others(c).slice(-1)[0];
      if (c.workspace && to) useWorkspaces.getState().activateTab(c.workspace.id, to.id);
    },
  },
  { id: "connection.new", title: t.newConnection, run: (c) => c.newConnection() },
  {
    id: "schema.change",
    title: t.changeSchema,
    when: (c) => connected(c) && (c.workspace?.schemas.length ?? 0) > 0,
    run: (c) => c.pickSchema(),
  },
  {
    id: "database.change",
    title: t.changeDatabase,
    when: (c) => connected(c) && c.workspace?.dialect === "postgres",
    run: (c) => c.pickDatabase(),
  },
  {
    id: "editor.format",
    title: t.format,
    shortcut: "Mod+Shift+F",
    when: (c) => {
      const q = queryTab(c);
      return q !== null && hasEditorCommand(q.id, "format");
    },
    run: (c) => {
      const q = queryTab(c);
      if (q) runEditorCommand(q.id, "format");
    },
  },
  {
    id: "editor.comment",
    title: t.toggleComment,
    shortcut: "Mod+/",
    when: (c) => {
      const q = queryTab(c);
      return q !== null && hasEditorCommand(q.id, "toggleComment");
    },
    run: (c) => {
      const q = queryTab(c);
      if (q) runEditorCommand(q.id, "toggleComment");
    },
  },
  {
    id: "sidebar.toggle",
    title: t.toggleSidebar,
    when: connected,
    run: () => useWorkspaces.getState().toggleSidebar(),
  },
  {
    id: "catalog.reload",
    title: t.reloadCatalog,
    when: (c) => connected(c) && c.workspace?.currentSchema != null,
    run: (c) => {
      if (c.workspace) void useCatalog.getState().refreshCatalog(c.workspace.id, c.workspace.currentSchema);
    },
  },
  // Plan 4 Task 8 (ruling R7): toggles the history panel of the active SQL tab.
  {
    id: "history.toggle",
    title: t.openHistory,
    shortcut: "Mod+Shift+H",
    when: (c) => queryTab(c) !== null,
    run: (c) => {
      const q = queryTab(c);
      if (q) useQueryPanels.getState().toggleHistory(q.id);
    },
  },
];

export const visibleActions = (ctx: ActionCtx): Action[] =>
  ACTIONS.filter((a) => a.when?.(ctx) ?? true);
