import { useSettings } from "../stores/settings";
import {
  FOCUS_SCOPES,
  FOCUS_SCOPE_ATTR,
  type KeymapActionId,
  KEYMAP_ACTIONS,
  type ShortcutScope,
  actionsOfScope,
  effectiveShortcut,
  effectiveShortcuts,
} from "./keymapRegistry";
import { type ShortcutOptions, matchCombination, useShortcut } from "./shortcuts";

// The registry and grammar live in the leaf module ./keymapRegistry (the settings store and
// bounds.ts import it directly); this module adds the React/store parts on top of it.
export * from "./keymapRegistry";

/** The focus scope `target` is in: its nearest `data-shortcut-scope` region, if any. */
export function focusScopeOf(target: EventTarget | null): ShortcutScope | null {
  if (!(target instanceof Element)) return null;
  const region = target.closest(`[${FOCUS_SCOPE_ATTR}]`);
  const scope = region?.getAttribute(FOCUS_SCOPE_ATTR) as ShortcutScope | undefined;
  return scope && FOCUS_SCOPES.includes(scope) ? scope : null;
}

/**
 * The action of the focused region's scope that takes `e` instead of action `id` (spec §5.5,
 * amendment #90): while the focus is in the SQL editor or the filter bar, their actions win
 * over every other scope's on the same keys (Ctrl+Shift+F formats in the editor, searches the
 * sidebar elsewhere; a table tab key never fires before the filter bar's). Null when `id`
 * may act.
 */
export function shadowingAction(
  id: KeymapActionId,
  e: KeyboardEvent,
  keymap: Record<string, string>,
): KeymapActionId | null {
  const scope = focusScopeOf(e.target);
  const own = KEYMAP_ACTIONS.find((a) => a.id === id)?.scope;
  if (scope === null || scope === own) return null;
  return (
    actionsOfScope(scope).find((other) =>
      effectiveShortcuts(other, keymap).some((spec) => matchCombination(e, spec)),
    ) ?? null
  );
}

/** `effectiveShortcut` with the keymap of the settings store; re-renders when it changes. */
export function useEffectiveShortcut(id: KeymapActionId): string {
  return useSettings((s) => effectiveShortcut(id, s.settings.keymap));
}

/** `effectiveShortcuts` (default and alternates, or the custom one) with the store's keymap. */
export function useEffectiveShortcuts(id: KeymapActionId): string[] {
  // Joined so the selector returns a stable value (a new array each call would re-render).
  return useSettings((s) => effectiveShortcuts(id, s.settings.keymap).join("\n")).split("\n");
}

/**
 * Binds action `id` to its effective combinations (`useShortcut` with the specs the keymap
 * gives it: the default and its alternates, or the custom one): a combination changed in
 * the settings takes effect at once, the old ones stop. A key that an action of the focused
 * region's scope takes (`shadowingAction`) is left to it.
 */
export function useAction(id: KeymapActionId, handler: (e: KeyboardEvent) => void, opts?: ShortcutOptions): void {
  // Joined so the hook sees a stable value (a new array each render would rebind).
  const specs = useSettings((s) => effectiveShortcuts(id, s.settings.keymap).join("\n"));
  useShortcut(specs.split("\n"), handler, {
    ...opts,
    yieldTo: (e) => shadowingAction(id, e, useSettings.getState().settings.keymap) !== null || (opts?.yieldTo?.(e) ?? false),
  });
}
