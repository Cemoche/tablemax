import { FileCode } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { toAppError } from "../../lib/errors";
import * as ipc from "../../lib/ipc";
import { strings } from "../../lib/strings";
import { useSavedQueries } from "../../stores/savedQueries";
import { type Workspace } from "../../stores/workspaces";
import { ContextMenu, type MenuAnchor, keyboardMenuAnchor, restoreFocusOnClose } from "../sidebar/ContextMenu";
import { SidebarSearch } from "../sidebar/SidebarSearch";
import { copyText, insertSql, runActiveTab } from "../sidebar/sqlActions";
import { ConfirmDialog, NameDialog } from "./Dialogs";

const S = strings.savedQueries;
const M = strings.sqlMenu;

/**
 * The sidebar's Queries tab: the connection's saved queries. A click opens one (in a new
 * linked SQL tab, or the tab already linked); the context menu runs, copies, inserts it
 * in the SQL tab on screen, renames or deletes it (confirmed).
 */
export function SavedQueries({ workspace }: { workspace: Workspace }) {
  const connectionId = workspace.connectionId;
  const list = useSavedQueries((s) => s.lists[connectionId]);
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /** The open menu and its row's button (the focus goes back there on close). */
  const [menu, setMenu] = useState<{ name: string; anchor: MenuAnchor; trigger: HTMLElement } | null>(null);

  useEffect(() => {
    let live = true;
    useSavedQueries
      .getState()
      .load(connectionId)
      .then(
        () => live && setLoadError(false),
        () => live && setLoadError(true),
      );
    return () => {
      live = false;
    };
  }, [connectionId]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list ?? []).filter((x) => !q || x.name.toLowerCase().includes(q));
  }, [list, search]);

  const fail = (e: unknown) => setNotice(S.actionFailed(toAppError(e).message));
  const read = (name: string) => ipc.savedQueryRead(connectionId, name);

  const open = (name: string) => {
    setNotice(null);
    return useSavedQueries.getState().open(workspace.id, name).catch(fail);
  };

  const rename = async (to: string) => {
    if (!renaming) return;
    if (to === renaming) return setRenaming(null);
    try {
      await useSavedQueries.getState().rename(connectionId, renaming, to);
      setRenaming(null);
      setRenameError(null);
    } catch (e) {
      setRenameError(toAppError(e).message);
    }
  };

  const remove = async () => {
    const name = deleting;
    setDeleting(null);
    if (!name) return;
    try {
      await useSavedQueries.getState().remove(connectionId, name);
    } catch (e) {
      fail(e);
    }
  };

  const menuItems = (name: string) => [
    {
      label: M.run,
      run: () => {
        setNotice(null);
        useSavedQueries
          .getState()
          .open(workspace.id, name)
          .then(() => runActiveTab(workspace.id), fail);
      },
    },
    { label: M.copy, run: () => void read(name).then(copyText).catch(fail) },
    { label: M.insert, run: () => void read(name).then((sql) => insertSql(workspace.id, sql), fail) },
    {
      label: M.rename,
      run: () => {
        setRenameError(null);
        setRenaming(name);
      },
    },
    { label: M.delete, run: () => setDeleting(name) },
  ];

  return (
    <section aria-label={S.label} className="flex min-h-0 flex-1 flex-col">
      <SidebarSearch label={S.search} placeholder={S.searchPlaceholder} value={search} onChange={setSearch} />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {loadError && <p className="px-1.5 py-1 text-danger">{S.loadFailed}</p>}
        {notice && (
          <p role="alert" className="px-1.5 py-1 text-danger">
            {notice}
          </p>
        )}
        {list?.length === 0 && !loadError && <p className="px-1.5 py-1 text-text-2">{S.empty}</p>}
        {list && list.length > 0 && shown.length === 0 && <p className="px-1.5 py-1 text-text-2">{S.noMatch}</p>}
        {shown.length > 0 && (
          <ul>
            {shown.map((q) => (
              <li key={q.name}>
                <button
                  type="button"
                  aria-label={S.open(q.name)}
                  title={q.name}
                  onClick={() => void open(q.name)}
                  onContextMenu={(e: MouseEvent<HTMLButtonElement>) => {
                    e.preventDefault();
                    setMenu({ name: q.name, anchor: { x: e.clientX, y: e.clientY }, trigger: e.currentTarget });
                  }}
                  onKeyDown={(e) => {
                    const anchor = keyboardMenuAnchor(e);
                    if (anchor) setMenu({ name: q.name, anchor, trigger: e.currentTarget });
                  }}
                  className="flex h-6 w-full items-center gap-1.5 rounded-md px-1.5 text-left whitespace-nowrap text-text outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <FileCode aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-text-2" />
                  <span className="min-w-0 truncate">{q.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {menu && (
        <ContextMenu
          label={S.menuLabel}
          anchor={menu.anchor}
          items={menuItems(menu.name)}
          onClose={(reason) => {
            setMenu(null);
            const { trigger } = menu;
            restoreFocusOnClose(reason, () => {
              if (trigger.isConnected) trigger.focus();
            });
          }}
        />
      )}
      {renaming !== null && (
        <NameDialog
          title={S.renameTitle}
          label={S.nameLabel}
          initial={renaming}
          confirm={S.renameConfirm}
          cancel={S.cancel}
          error={renameError}
          onSubmit={(name) => void rename(name)}
          onCancel={() => setRenaming(null)}
        />
      )}
      {deleting !== null && (
        <ConfirmDialog
          title={S.deleteTitle}
          body={S.deleteBody(deleting)}
          confirm={S.deleteConfirm}
          cancel={S.cancel}
          danger
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
