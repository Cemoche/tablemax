import { useSettings } from "../stores/settings";
import { type KeymapActionId, effectiveShortcut, effectiveShortcuts } from "./keymapRegistry";
import { type ShortcutOptions, useShortcut } from "./shortcuts";

// The registry and grammar live in the leaf module ./keymapRegistry (the settings store and
// bounds.ts import it directly); this module adds the React/store parts on top of it.
export * from "./keymapRegistry";

/** `effectiveShortcut` with the keymap of the settings store; re-renders when it changes. */
export function useEffectiveShortcut(id: KeymapActionId): string {
  return useSettings((s) => effectiveShortcut(id, s.settings.keymap));
}

/**
 * Binds action `id` to its effective combinations (`useShortcut` with the specs the keymap
 * gives it: the default and its alternates, or the custom one): a combination changed in
 * the settings takes effect at once, the old ones stop.
 */
export function useAction(id: KeymapActionId, handler: (e: KeyboardEvent) => void, opts?: ShortcutOptions): void {
  // Joined so the hook sees a stable value (a new array each render would rebind).
  const specs = useSettings((s) => effectiveShortcuts(id, s.settings.keymap).join("\n"));
  useShortcut(specs.split("\n"), handler, opts);
}
