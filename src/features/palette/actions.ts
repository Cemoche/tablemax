import { strings } from "../../lib/strings";
import { type Tab, type Workspace, capabilitiesOf, useWorkspaces } from "../../stores/workspaces";
import { useCatalog } from "../../stores/catalog";
import { hasEditorCommand, runEditorCommand } from "../editor/editorCommands";
import { showSidebarSegment } from "../../stores/sidebar";
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
  /** An action with a shortcut uses its keymap id (src/lib/keymap.ts); the palette shows its effective combination. */
  id: string;
  title: string;
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
    when: (c) => c.workspace !== null && capabilitiesOf(c.workspace).sqlEditor,
    run: (c) => c.workspace && useWorkspaces.getState().openQueryTab(c.workspace.id),
  },
  {
    id: "tab.close",
    title: t.closeTab,
    when: (c) => c.workspace !== null && c.workspace.activeTabId !== null,
    run: (c) => {
      if (c.workspace?.activeTabId) useWorkspaces.getState().closeTab(c.workspace.id, c.workspace.activeTabId);
    },
  },
  {
    id: "tab.next",
    title: t.nextTab,
    when: (c) => others(c).length > 0,
    run: (c) => {
      const to = others(c)[0];
      if (c.workspace && to) useWorkspaces.getState().activateTab(c.workspace.id, to.id);
    },
  },
  {
    id: "tab.previous",
    title: t.previousTab,
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
    when: (c) => connected(c) && c.workspace !== null && capabilitiesOf(c.workspace).databaseSwitch,
    run: (c) => c.pickDatabase(),
  },
  {
    id: "editor.format",
    title: t.format,
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
  // UI redesign Task 3: the history is the sidebar's History tab.
  {
    id: "history.toggle",
    title: t.openHistory,
    when: connected,
    run: (c) => {
      if (c.workspace) showSidebarSegment(c.workspace.id, "history");
    },
  },
];

export const visibleActions = (ctx: ActionCtx): Action[] =>
  ACTIONS.filter((a) => a.when?.(ctx) ?? true);
