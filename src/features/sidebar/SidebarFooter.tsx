import { ChevronDown, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { tip } from "../../lib/tooltip";
import { useCatalog } from "../../stores/catalog";
import { useChrome } from "../../stores/chrome";
import { type Workspace, capabilitiesOf, useWorkspaces } from "../../stores/workspaces";
import { ContextMenu, type MenuAnchor, restoreFocusOnClose } from "./ContextMenu";

const S = strings.sidebar;

const iconButton =
  "flex h-6.5 w-7 items-center justify-center text-icon outline-none hover:bg-seg-sel disabled:text-icon-dim focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** Reloads the sidebar's lists and rebuilds the catalog (the toolbar's Reload minus the table page). */
export function refreshSidebar(ws: Workspace) {
  useChrome.getState().requestReload(ws.id);
  void useCatalog.getState().refreshCatalog(ws.id, ws.currentSchema);
}

/**
 * The bottom of the sidebar (spec §2.3): [+ | ⌄] (new SQL tab; a menu with New SQL query
 * and Refresh) and the schema picker. The settings live at the bottom of the connections
 * column (#104).
 */
export function SidebarFooter({ workspace }: { workspace: Workspace }) {
  const setSchema = useWorkspaces((s) => s.setSchema);
  const { sqlEditor } = capabilitiesOf(workspace);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const newQuery = () => useWorkspaces.getState().openQueryTab(workspace.id);
  const newQueryKey = formatShortcut(useEffectiveShortcut("query.new"));

  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-t border-sep px-2">
      <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-pill-border bg-btn">
        {sqlEditor && (
          <button type="button" aria-label={S.newQuery} {...tip(S.newQuery, newQueryKey)} onClick={newQuery} className={iconButton}>
            <Plus aria-hidden size={15} strokeWidth={1.6} />
          </button>
        )}
        <button
          ref={more}
          type="button"
          aria-label={S.more}
          {...tip(S.more)}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={() => {
            const r = more.current?.getBoundingClientRect();
            setMenu(menu ? null : { x: r?.left ?? 0, y: r?.top ?? 0 });
          }}
          className={`${iconButton} ${sqlEditor ? "border-l border-pill-border" : ""}`}
        >
          <ChevronDown aria-hidden size={14} strokeWidth={1.6} />
        </button>
      </div>
      <select
        aria-label={S.schema}
        {...tip(S.schema)}
        value={workspace.currentSchema ?? ""}
        disabled={workspace.schemas.length === 0}
        onChange={(e) => setSchema(workspace.id, e.target.value)}
        className="h-6.5 min-w-0 flex-1 rounded-md border border-pill-border bg-btn px-1.5 font-mono text-sm text-text outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
      >
        {workspace.schemas.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {menu && (
        <ContextMenu
          label={S.more}
          anchor={menu}
          trigger={more}
          items={[
            ...(sqlEditor ? [{ label: S.newQuery, run: newQuery }] : []),
            { label: S.refresh, run: () => refreshSidebar(workspace) },
          ]}
          onClose={(reason) => {
            setMenu(null);
            restoreFocusOnClose(reason, () => more.current?.focus());
          }}
        />
      )}
    </div>
  );
}
