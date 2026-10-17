// The pure keymap registry: a leaf module (strings and platform only, no store or feature),
// so the settings store and bounds.ts can use it. React hooks live in ./keymap.
import { isMac } from "./platform";
import { strings } from "./strings";

/**
 * Where a shortcut acts (orchestrator ruling a, controller ruling B-R1):
 * - `global`: anywhere in the window; it shadows every other scope.
 * - `queryTab` / `tableTab`: the active SQL tab / table tab. They are never both active,
 *   so they share combinations (Mod+S saves a query, commits a table).
 * - `editor`: the SQL editor, which lives inside a query tab: its keymap fires first and
 *   the query tab's window listener then sees the same keydown, so it conflicts with
 *   `queryTab` as well as with itself and `global`.
 */
export type ShortcutScope = "global" | "queryTab" | "tableTab" | "editor";

/**
 * The actions that have a shortcut. The ids are also listed, in this order, in
 * `keymap-actions.json`, which `src-tauri/src/settings.rs` checks `KEYMAP_ACTION_IDS`
 * against (each side has a test asserting its list equals that file). Palette actions with
 * a shortcut use the same id.
 */
const SPECS = {
  "query.new": { scope: "global", defaultShortcut: "Mod+T" },
  "tab.close": { scope: "global", defaultShortcut: "Mod+W" },
  "tab.next": { scope: "global", defaultShortcut: "Ctrl+Tab" },
  "tab.previous": { scope: "global", defaultShortcut: "Ctrl+Shift+Tab" },
  "palette.all": { scope: "global", defaultShortcut: "Mod+K" },
  "palette.objects": { scope: "global", defaultShortcut: "Mod+P" },
  "settings.open": { scope: "global", defaultShortcut: "Mod+," },
  "query.save": { scope: "queryTab", defaultShortcut: "Mod+S" },
  "history.toggle": { scope: "queryTab", defaultShortcut: "Mod+Shift+H" },
  "editor.run": { scope: "editor", defaultShortcut: "Mod+Enter" },
  "editor.runAll": { scope: "editor", defaultShortcut: "Mod+Shift+Enter" },
  "editor.format": { scope: "editor", defaultShortcut: "Mod+Shift+F" },
  "editor.comment": { scope: "editor", defaultShortcut: "Mod+/" },
  "grid.commit": { scope: "tableTab", defaultShortcut: "Mod+S" },
  "grid.rowDetails": { scope: "tableTab", defaultShortcut: "Mod+I" },
  "grid.viewData": { scope: "tableTab", defaultShortcut: "Alt+1" },
  "grid.viewStructure": { scope: "tableTab", defaultShortcut: "Alt+2" },
  "grid.back": { scope: "tableTab", defaultShortcut: "Alt+ArrowLeft" },
} as const satisfies Record<keyof typeof strings.keymap, { scope: ShortcutScope; defaultShortcut: string }>;

export type KeymapActionId = keyof typeof SPECS;

export interface KeymapAction {
  id: KeymapActionId;
  /** From `strings.keymap`. */
  label: string;
  scope: ShortcutScope;
  /** Canonical spec (see `isValidShortcut`). */
  defaultShortcut: string;
}

export const KEYMAP_ACTIONS: readonly KeymapAction[] = (Object.keys(SPECS) as KeymapActionId[]).map((id) => ({
  id,
  label: strings.keymap[id],
  scope: SPECS[id].scope,
  defaultShortcut: SPECS[id].defaultShortcut,
}));

export const DEFAULT_KEYMAP: Record<KeymapActionId, string> = Object.fromEntries(
  KEYMAP_ACTIONS.map((a) => [a.id, a.defaultShortcut]),
) as Record<KeymapActionId, string>;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function isKeymapActionId(id: string): id is KeymapActionId {
  return own(SPECS, id);
}

/** Longest spec accepted (mirrors `KEYMAP_SPEC_MAX` in src-tauri/src/settings.rs). */
export const SHORTCUT_MAX = 32;
const MODIFIERS = new Set(["Mod", "Ctrl", "Meta", "Alt", "Shift"]);
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;
const CHAR_KEY = /^[A-Z0-9,./;\-=[\]\\`]$/;

/**
 * The canonical shortcut grammar (mirrored by `is_valid_shortcut` in
 * src-tauri/src/settings.rs): `Modifier+…+Key`, modifiers among Mod, Ctrl, Meta, Alt,
 * Shift, each at most once, in any order; Key = one uppercase ASCII letter or digit, one
 * of `, . / ; - = [ ] \ \``, or a named key (Enter, Tab, Escape, Space, Backspace, Delete,
 * ArrowUp/Down/Left/Right, F1–F12). At least one modifier unless the key is F1–F12; at most
 * 32 characters. Everything it accepts, `matchShortcut` can match.
 */
export function isValidShortcut(spec: string): boolean {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > SHORTCUT_MAX) return false;
  const parts = spec.split("+");
  const key = parts.pop() as string;
  const seen = new Set<string>();
  for (const m of parts) {
    if (!MODIFIERS.has(m) || seen.has(m)) return false;
    seen.add(m);
  }
  const fn = FUNCTION_KEY.test(key);
  if (!fn && !NAMED_KEYS.has(key) && !CHAR_KEY.test(key)) return false;
  return fn || seen.size > 0;
}

/** The combination `id` uses: its keymap entry when that is a valid spec, else its default. */
export function effectiveShortcut(id: KeymapActionId, keymap: Record<string, string>): string {
  const custom = own(keymap, id) ? keymap[id] : undefined;
  return typeof custom === "string" && isValidShortcut(custom) ? custom : SPECS[id].defaultShortcut;
}

/** Two scopes can be active for the same keydown (see `ShortcutScope`). */
function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === b || a === "global" || b === "global") return true;
  return (a === "editor" && b === "queryTab") || (a === "queryTab" && b === "editor");
}

/** The physical combination of a valid spec, `Mod` resolved for the platform. */
function combination(spec: string, mac: boolean): string {
  const parts = spec.split("+");
  const key = parts.pop() as string;
  const mods = new Set(parts.map((m) => (m === "Mod" ? (mac ? "Meta" : "Ctrl") : m)));
  return [...["Ctrl", "Meta", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("+");
}

/**
 * The action that would fire along with `id` if `id` used `spec`: another action whose
 * effective combination is the same physical keys (Mod = Cmd on macOS, Ctrl elsewhere) in
 * an overlapping scope. Null when there is none or `spec` is not a valid spec.
 */
export function conflictFor(
  id: KeymapActionId,
  spec: string,
  keymap: Record<string, string>,
  mac: boolean = isMac(),
): KeymapActionId | null {
  if (!isValidShortcut(spec)) return null;
  const scope = SPECS[id].scope;
  const wanted = combination(spec, mac);
  for (const other of KEYMAP_ACTIONS) {
    if (other.id === id || !scopesOverlap(scope, other.scope)) continue;
    if (combination(effectiveShortcut(other.id, keymap), mac) === wanted) return other.id;
  }
  return null;
}
