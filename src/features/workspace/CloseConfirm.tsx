import { strings } from "../../lib/strings";
import { useRestoreFocus } from "../../lib/useRestoreFocus";
import { useWorkspaces } from "../../stores/workspaces";
import { ConfirmDialog } from "./ConfirmDialog";
import { focusActiveTab } from "./focusActiveTab";

/**
 * "Discard N pending changes?" before a tab or a workspace with pending changes closes.
 * Mounted once at the app root: a workspace can be closed from the switcher while
 * another view is shown.
 */
export function CloseConfirm() {
  const req = useWorkspaces((s) => s.closeRequest);
  if (!req) return null;
  return <CloseConfirmDialog req={req} />;
}

type CloseRequest = NonNullable<ReturnType<typeof useWorkspaces.getState>["closeRequest"]>;

function CloseConfirmDialog({ req }: { req: CloseRequest }) {
  // Cancel: the focus goes back to what had it (the tab, the grid, the editor).
  useRestoreFocus();
  const confirmClose = useWorkspaces((s) => s.confirmClose);
  const cancelClose = useWorkspaces((s) => s.cancelClose);
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
      onConfirm={() =>
        void confirmClose()
          .catch(() => {})
          .finally(refocusAfterClose)
      }
      onCancel={cancelClose}
    />
  );
}

/**
 * Discard: the closed tab often took the element that had the focus along with it (Ctrl+W
 * from its grid or its tab), so the focus would fall to <body>; the tab now shown gets it.
 * Checked once the close has rendered.
 */
function refocusAfterClose() {
  setTimeout(() => {
    const active = document.activeElement;
    if (!active || active === document.body) focusActiveTab();
  }, 0);
}
