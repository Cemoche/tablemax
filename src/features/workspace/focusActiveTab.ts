import { useWorkspaces } from "../../stores/workspaces";
import { runEditorCommand } from "../editor/editorCommands";

/** The opener is gone (its tab was replaced): focus the active tab's editor or content. */
export function focusActiveTab(): void {
  const { workspaces, activeWorkspaceId } = useWorkspaces.getState();
  const w = workspaces.find((x) => x.id === activeWorkspaceId);
  if (w?.activeTabId && runEditorCommand(w.activeTabId, "focus")) return;
  document.querySelector<HTMLElement>("[data-tab-content]")?.focus();
}
