import { CircleX, Command, Database, Eye, ListChecks, PanelLeft, PanelRight, Plug, RotateCw, Settings } from "lucide-react";
import { type MouseEvent, type ReactNode, useId, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { type KeymapActionId, useAction, useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { type TipProps, tip } from "../../lib/tooltip";
import type { ConnectionConfig } from "../../lib/types";
import { useCatalog } from "../../stores/catalog";
import { useChrome } from "../../stores/chrome";
import { useConnections } from "../../stores/connections";
import { usePendingChanges } from "../../stores/pendingChanges";
import { useSettings } from "../../stores/settings";
import { type Workspace, capabilitiesOf, useWorkspaces } from "../../stores/workspaces";
import { ConnectionPopover } from "./ConnectionPopover";
import { SafeModeMenu } from "./SafeModeMenu";
import { StatusPill } from "./StatusPill";
import { ICON, iconButton, pillGroup } from "./toolbarStyles";
import { WindowControls } from "./WindowControls";
import { toggleMaximize, useTrackMaximized } from "./windowState";

const t = strings.toolbar;

/** Presses on these never move the window. */
const INTERACTIVE = "button, a, input, select, textarea, [role='menu'], [role='dialog']";

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className={pillGroup}>
      {children}
    </div>
  );
}

/** Tooltip with the action's effective shortcut. */
function useHint(label: string, id: KeymapActionId): TipProps {
  return tip(label, formatShortcut(useEffectiveShortcut(id)));
}

/** Reloads what the workspace shows: its sidebar, its catalog and the active table tab's page. */
function reloadWorkspace(ws: Workspace | null) {
  if (!ws || ws.status !== "connected") return;
  const chrome = useChrome.getState();
  chrome.requestReload(ws.id);
  if (ws.currentSchema !== null) void useCatalog.getState().refreshCatalog(ws.id, ws.currentSchema);
  const tab = ws.tabs.find((x) => x.id === ws.activeTabId);
  if (tab?.kind === "table") chrome.requestReload(tab.id);
}

interface Props {
  /** The workspace on screen; null on the connections screen. */
  workspace: Workspace | null;
  /** Why the last connect of the shown (disconnected) workspace failed. */
  connectError?: string | null;
  /** Shows the form of a saved connection (the popover's Edit). */
  onEditConnection: (cfg: ConnectionConfig) => void;
}

/**
 * The unified toolbar (spec §2.3), which is also the title bar of the frameless window:
 * [sidebar · connection] [Discard · Preview · Commit] [safe mode · database · SQL]
 * status pill [reload · command palette (Open anything)] [row details] and the window
 * buttons. TableMax has no metrics view and no console panel yet, so their buttons are not
 * shown (#104). A press on its empty space moves the window; a double press maximizes or
 * restores it.
 */
export function AppToolbar({ workspace, connectError = null, onEditConnection }: Props) {
  const systemTitleBar = useSettings((s) => s.systemTitleBar);
  useTrackMaximized();
  useAction("workspace.reload", () => reloadWorkspace(workspace));
  const settingsHint = useHint(strings.settings.open, "settings.open");
  // With a workspace open, the connections column shows and holds the settings (#104).
  const columnShown = useWorkspaces((s) => s.workspaces.length > 0);

  const onMouseDown = (e: MouseEvent<HTMLElement>) => {
    if (systemTitleBar || e.button !== 0) return;
    if ((e.target as Element).closest(INTERACTIVE)) return;
    // Like a native title bar: the second press of a double click maximizes or restores
    // (the move started by the first press swallows the dblclick event itself).
    if (e.detail === 2) toggleMaximize();
    else void ipc.windowStartDrag()?.catch(() => {});
  };

  return (
    <header
      onMouseDown={onMouseDown}
      className="flex h-13 shrink-0 items-center gap-2 border-b border-sep bg-win px-2.5 select-none"
    >
      {workspace ? (
        <WorkspaceTools workspace={workspace} connectError={connectError} onEditConnection={onEditConnection} />
      ) : (
        <>
          {!columnShown && (
            <button
              type="button"
              aria-label={strings.settings.open}
              {...settingsHint}
              onClick={() => useChrome.getState().requestSettings()}
              className={`${iconButton} shrink-0`}
            >
              <Settings aria-hidden {...ICON} />
            </button>
          )}
          <span className="flex-1 text-center font-semibold text-text-2">{strings.appName}</span>
        </>
      )}
      {!systemTitleBar && <WindowControls />}
    </header>
  );
}

function WorkspaceTools({
  workspace,
  connectError,
  onEditConnection,
}: {
  workspace: Workspace;
  connectError: string | null;
  onEditConnection: (cfg: ConnectionConfig) => void;
}) {
  const cfg = useConnections((s) => s.items.find((c) => c.id === workspace.connectionId));
  const toggleSidebar = useWorkspaces((s) => s.toggleSidebar);
  const sidebarVisible = useWorkspaces((s) => s.sidebarVisible);
  const openQueryTab = useWorkspaces((s) => s.openQueryTab);
  const connected = workspace.status === "connected";
  const caps = capabilitiesOf(workspace);
  const tab = workspace.tabs.find((x) => x.id === workspace.activeTabId) ?? null;
  const table = connected && tab?.kind === "table" ? tab : null;

  // The commit group acts on the active table tab's pending changes (as Mod+S does).
  const count = usePendingChanges((s) => (table ? s.count(table.id) : 0));
  const busy = usePendingChanges(
    (s) =>
      table !== null &&
      (s.committing[table.id] === true || s.confirming[table.id] !== undefined || s.awaitingReload[table.id] === true),
  );
  const outcomeUnknown = usePendingChanges((s) => (table ? s.tabs[table.id]?.outcomeUnknown === true : false));
  // The tab's own commit runs (Discard's place holds Cancel), or another table tab of the
  // workspace commits (Commit waits): what the edit strip above the grid showed (#103).
  const committing = usePendingChanges((s) => (table ? s.committing[table.id] === true : false));
  const otherCommitting = usePendingChanges((s) => {
    const owner = s.committingIn[workspace.id];
    return table !== null && owner !== undefined && owner !== table.id;
  });
  const countId = useId();
  const reasonId = useId();
  const editorOpen = usePendingChanges((s) => (table ? s.editorOpen[table.id] === true : false));
  // One panel for the window (#79), shown by table tabs: off where none is active.
  const rowDetails = useChrome((s) => s.rowDetailsOpen) && table !== null;

  const [connectionOpen, setConnectionOpen] = useState(false);
  const connectionButton = useRef<HTMLButtonElement>(null);

  const sidebarHint = useHint(t.sidebar, "sidebar.toggle");
  const commitHint = useHint(t.commit, "grid.commit");
  const databaseHint = useHint(t.database, "database.open");
  const sqlHint = useHint(t.sql, "editor.open");
  const reloadHint = useHint(t.reload, "workspace.reload");
  const anythingHint = useHint(t.openAnything, "palette.all");
  const detailsHint = useHint(t.rowDetails, "grid.rowDetails");

  const canPickDatabase = connected && (caps.databaseSwitch || workspace.schemas.length > 0);

  return (
    <>
      <Group label={t.groups.navigation}>
        <button
          type="button"
          aria-label={t.sidebar}
          {...sidebarHint}
          aria-pressed={connected && sidebarVisible}
          disabled={!connected}
          onClick={toggleSidebar}
          className={iconButton}
        >
          <PanelLeft aria-hidden {...ICON} />
        </button>
        <div className="relative">
          <button
            ref={connectionButton}
            type="button"
            aria-label={t.connection}
            {...tip(t.connection)}
            aria-haspopup="dialog"
            aria-expanded={connectionOpen}
            onClick={() => setConnectionOpen((o) => !o)}
            className={iconButton}
          >
            <Plug aria-hidden {...ICON} />
          </button>
          {connectionOpen && (
            <ConnectionPopover
              workspace={workspace}
              cfg={cfg}
              align="start"
              onEditConnection={onEditConnection}
              onClose={(refocus) => {
                setConnectionOpen(false);
                if (refocus) connectionButton.current?.focus();
              }}
            />
          )}
        </div>
      </Group>

      <Group label={t.groups.changes}>
        {committing ? (
          <button
            type="button"
            aria-label={strings.grid.cancelCommitLabel}
            {...tip(strings.grid.cancelCommitLabel)}
            onClick={() => table && void usePendingChanges.getState().cancelCommit(table.id, workspace.id).catch(() => {})}
            className={iconButton}
          >
            <CircleX aria-hidden {...ICON} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={t.discard}
            {...tip(t.discard)}
            disabled={count === 0 || busy}
            onClick={() => table && usePendingChanges.getState().discard(table.id)}
            className={iconButton}
          >
            <CircleX aria-hidden {...ICON} />
          </button>
        )}
        <button
          type="button"
          aria-label={t.preview}
          {...tip(t.preview)}
          disabled={count === 0}
          onClick={() => table && useChrome.getState().requestPreview(table.id)}
          className={iconButton}
        >
          <Eye aria-hidden {...ICON} />
        </button>
        <button
          type="button"
          aria-label={t.commit}
          aria-describedby={
            [count > 0 ? countId : "", otherCommitting ? reasonId : ""].filter(Boolean).join(" ") || undefined
          }
          {...(otherCommitting ? tip(strings.grid.otherTabCommitting) : commitHint)}
          // Waiting on another tab is a reason to read: focusable, does nothing (review #109).
          aria-disabled={otherCommitting || undefined}
          disabled={!otherCommitting && (count === 0 || busy || outcomeUnknown || editorOpen)}
          onClick={() => {
            if (otherCommitting || !table) return;
            void usePendingChanges.getState().commit(table.id, workspace.id, table.object);
          }}
          className={`${iconButton} relative aria-disabled:text-icon-dim aria-disabled:hover:bg-transparent`}
        >
          <ListChecks aria-hidden {...ICON} />
          {count > 0 && (
            <span
              data-testid="pending-count"
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-accent-strong px-0.75 text-center text-[10px] leading-3.5 font-semibold text-accent-contrast tabular-nums"
            >
              {count > 99 ? t.pendingCountMax : count}
            </span>
          )}
        </button>
        {count > 0 && (
          <span id={countId} hidden>
            {strings.grid.pendingCount(count)}
          </span>
        )}
        {otherCommitting && (
          <span id={reasonId} hidden>
            {strings.grid.otherTabCommitting}
          </span>
        )}
      </Group>

      <Group label={t.groups.database}>
        <SafeModeMenu workspace={workspace} />
        <button
          type="button"
          aria-label={t.database}
          {...databaseHint}
          disabled={!canPickDatabase}
          onClick={() => useChrome.getState().requestPalette("database")}
          className={iconButton}
        >
          <Database aria-hidden {...ICON} />
        </button>
        {caps.sqlEditor && (
          <button
            type="button"
            aria-label={t.sql}
            {...sqlHint}
            onClick={() => openQueryTab(workspace.id)}
            className={`${iconButton} w-auto px-2.5 font-sans text-xs font-bold tracking-wide`}
          >
            <span aria-hidden>{t.sqlText}</span>
          </button>
        )}
      </Group>

      <StatusPill workspace={workspace} connectError={connectError} onEditConnection={onEditConnection} />

      <Group label={t.groups.search}>
        <button
          type="button"
          aria-label={t.reload}
          {...reloadHint}
          disabled={!connected}
          onClick={() => reloadWorkspace(workspace)}
          className={iconButton}
        >
          <RotateCw aria-hidden {...ICON} />
        </button>
        <button
          type="button"
          aria-label={t.openAnything}
          {...anythingHint}
          onClick={() => useChrome.getState().requestPalette("all")}
          className={iconButton}
        >
          <Command aria-hidden {...ICON} />
        </button>
      </Group>

      <Group label={t.groups.panels}>
        <button
          type="button"
          aria-label={t.rowDetails}
          {...detailsHint}
          aria-pressed={rowDetails}
          disabled={table === null}
          onClick={() => table && useChrome.getState().toggleRowDetails()}
          className={iconButton}
        >
          <PanelRight aria-hidden {...ICON} />
        </button>
      </Group>
    </>
  );
}
