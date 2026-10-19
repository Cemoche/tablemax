import { strings } from "../../lib/strings";
import { useWorkspaces } from "../../stores/workspaces";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * "Discard N pending changes?" before a tab or a workspace with pending changes closes.
 * Mounted once at the app root: a workspace can be closed from the switcher while
 * another view is shown.
 */
export function CloseConfirm() {
  const req = useWorkspaces((s) => s.closeRequest);
  const confirmClose = useWorkspaces((s) => s.confirmClose);
  const cancelClose = useWorkspaces((s) => s.cancelClose);
  if (!req) return null;
  return (
    <ConfirmDialog
      title={strings.grid.discardTitle}
      message={
        req.tabId === null
          ? strings.grid.discardConfirmWorkspace(req.count, req.tabs)
          : strings.grid.discardConfirm(req.count)
      }
      confirmLabel={strings.grid.discardOk}
      cancelLabel={strings.grid.discardCancel}
      onConfirm={() => void confirmClose().catch(() => {})}
      onCancel={cancelClose}
    />
  );
}
