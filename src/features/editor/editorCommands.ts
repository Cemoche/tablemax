/**
 * Command bridge between the palette and the mounted SQL editors: each editor registers
 * the commands it supports for its tab; the palette runs (and shows) them by name.
 */
export type EditorCommandName = "toggleComment" | "format";
export type EditorCommands = Partial<Record<EditorCommandName, () => void>>;

const registry = new Map<string, EditorCommands>();

/** Registers `commands` for `tabId`; returns the unregister function. */
export function registerEditorCommands(tabId: string, commands: EditorCommands): () => void {
  registry.set(tabId, commands);
  return () => {
    // A newer registration for the same tab (remount) must survive an older cleanup.
    if (registry.get(tabId) === commands) registry.delete(tabId);
  };
}

export function hasEditorCommand(tabId: string, name: EditorCommandName): boolean {
  return typeof registry.get(tabId)?.[name] === "function";
}

/** Runs the command; false when the tab has no editor mounted or lacks the command. */
export function runEditorCommand(tabId: string, name: EditorCommandName): boolean {
  const fn = registry.get(tabId)?.[name];
  if (!fn) return false;
  fn();
  return true;
}
