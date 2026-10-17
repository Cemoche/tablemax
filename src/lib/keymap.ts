import { useSettings } from "../stores/settings";
import { type KeymapActionId, effectiveShortcut } from "./keymapRegistry";
import { type ShortcutOptions, useShortcut } from "./shortcuts";

// The registry and grammar live in the leaf module ./keymapRegistry (the settings store and
// bounds.ts import it directly); this module adds the React/store parts on top of it.
export * from "./keymapRegistry";

/** `effectiveShortcut` with the keymap of the settings store; re-renders when it changes. */
export function useEffectiveShortcut(id: KeymapActionId): string {
  return useSettings((s) => effectiveShortcut(id, s.settings.keymap));
}

/**
 * Binds action `id` to its effective combination (`useShortcut` with the spec the keymap
 * gives it): a combination changed in the settings takes effect at once, the old one stops.
 */
export function useAction(id: KeymapActionId, handler: (e: KeyboardEvent) => void, opts?: ShortcutOptions): void {
  useShortcut(useEffectiveShortcut(id), handler, opts);
}
