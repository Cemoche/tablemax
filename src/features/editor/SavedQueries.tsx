import { useEffect, useState } from "react";
import { toAppError } from "../../lib/errors";
import { strings } from "../../lib/strings";
import { useSavedQueries } from "../../stores/savedQueries";
import { type Workspace } from "../../stores/workspaces";
import { ConfirmDialog, NameDialog } from "./Dialogs";

const S = strings.savedQueries;

/**
 * The connection's saved queries, in a collapsible section on the left of the SQL tab:
 * open (in a new linked tab, or the tab already linked), rename, delete (confirmed).
 */
export function SavedQueries({ workspace }: { workspace: Workspace }) {
  const connectionId = workspace.connectionId;
  const list = useSavedQueries((s) => s.lists[connectionId]);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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

  const fail = (e: unknown) => setNotice(S.actionFailed(toAppError(e).message));

  const open = (name: string) => {
    setNotice(null);
    useSavedQueries.getState().open(workspace.id, name).catch(fail);
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

  return (
    <section aria-label={S.label} className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
      <h3 className="border-b border-border px-2 py-1 text-xs font-semibold text-muted uppercase">{S.label}</h3>
      <div className="min-h-0 flex-1 overflow-auto">
        {loadError && <p className="p-2 text-sm text-danger">{S.loadFailed}</p>}
        {notice && (
          <p role="alert" className="p-2 text-sm text-danger">
            {notice}
          </p>
        )}
        {list?.length === 0 && !loadError && <p className="p-2 text-sm text-muted">{S.empty}</p>}
        {list && list.length > 0 && (
          <ul>
            {list.map((q) => (
              <li key={q.name} className="group flex items-center hover:bg-surface-2">
                <button
                  type="button"
                  aria-label={S.open(q.name)}
                  title={q.name}
                  onClick={() => open(q.name)}
                  className="min-w-0 flex-1 truncate px-2 py-0.5 text-left text-sm"
                >
                  {q.name}
                </button>
                <button
                  type="button"
                  aria-label={S.rename(q.name)}
                  title={S.rename(q.name)}
                  onClick={() => {
                    setRenameError(null);
                    setRenaming(q.name);
                  }}
                  className="px-1 text-sm text-muted opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  {S.renameIcon}
                </button>
                <button
                  type="button"
                  aria-label={S.delete(q.name)}
                  title={S.delete(q.name)}
                  onClick={() => setDeleting(q.name)}
                  className="px-1 text-sm text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                >
                  {S.deleteIcon}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
