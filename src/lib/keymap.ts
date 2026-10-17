import { useSettings } from "../stores/settings";
import { type KeymapActionId, effectiveShortcut } from "./keymapRegistry";

// The registry and grammar live in the leaf module ./keymapRegistry (the settings store and
// bounds.ts import it directly); this module adds the React/store parts on top of it.
export * from "./keymapRegistry";

/** `effectiveShortcut` with the keymap of the settings store; re-renders when it changes. */
export function useEffectiveShortcut(id: KeymapActionId): string {
  return useSettings((s) => effectiveShortcut(id, s.settings.keymap));
}
