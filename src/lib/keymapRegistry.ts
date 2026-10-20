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
 * - `filterBar`: the filter bar of a table tab, while the focus is in it (Task 6). It
 *   handles its keys itself and stops them there, so inside the bar they win over the
 *   table tab's (Mod+I adds a filter row there, a table row elsewhere, spec §5.3): it
 *   conflicts only with itself and `global`.
 * - `connectionList`: the connections screen (Task 8). No workspace view is on screen
 *   then, so it shares combinations with the tab scopes (Mod+F searches the list there and
 *   opens the filters of a table tab): it conflicts only with itself and `global`.
 */
export type ShortcutScope = "global" | "queryTab" | "tableTab" | "editor" | "filterBar" | "connectionList";

/**
 * The actions that have a shortcut. The ids are also listed, in this order, in
 * `keymap-actions.json`, which `src-tauri/src/settings.rs` checks `KEYMAP_ACTION_IDS`
 * against (each side has a test asserting its list equals that file). Palette actions with
 * a shortcut use the same id.
 */
type Spec = {
  scope: ShortcutScope;
  defaultShortcut: string;
  /**
   * More default combinations of the action, bound with the default (spec §5.5: for
   * layouts where `[` / `]` need AltGr). A custom shortcut replaces all of them.
   */
  alternates?: readonly string[];
  /**
   * macOS's own default and alternates, when they differ. Off macOS Ctrl+Alt is AltGr on
   * many layouts (Windows always, Linux layouts with a third level): a Ctrl+Alt combination
   * types a character there (or is taken for one), so only macOS may use ⌘⌥.
   */
  mac?: { defaultShortcut?: string; alternates?: readonly string[] };
  /**
   * Actions of another scope this one deliberately shares combinations with: inside its
   * focus scope (see `FOCUS_SCOPES`) this action wins, elsewhere the other one acts, so the
   * pair is no conflict (spec §5.3: Ctrl+Shift+F formats in the editor, searches the
   * sidebar elsewhere). Declared on the inner action only.
   */
  shadows?: readonly string[];
};

const SPECS = {
  "query.new": { scope: "global", defaultShortcut: "Mod+T" },
  "tab.close": { scope: "global", defaultShortcut: "Mod+W" },
  // Ctrl+Tab keeps the most-recent order (TabSwitcher); the alternates move in tab bar
  // order (spec §5.3: Ctrl+[ / Ctrl+], and §5.5: Ctrl+PageUp / PageDown for AltGr layouts).
  "tab.next": { scope: "global", defaultShortcut: "Ctrl+Tab", alternates: ["Mod+]", "Mod+PageDown"] },
  "tab.previous": { scope: "global", defaultShortcut: "Ctrl+Shift+Tab", alternates: ["Mod+[", "Mod+PageUp"] },
  "palette.all": { scope: "global", defaultShortcut: "Mod+P" },
  "settings.open": { scope: "global", defaultShortcut: "Mod+," },
  "query.save": { scope: "queryTab", defaultShortcut: "Mod+S" },
  "history.toggle": { scope: "global", defaultShortcut: "Mod+Shift+H" },
  "editor.run": { scope: "editor", defaultShortcut: "Mod+Enter" },
  "editor.runAll": { scope: "editor", defaultShortcut: "Mod+Shift+Enter" },
  // Spec §5.3 (Beautify ⌘I; "Ctrl+Shift+F reste aussi"): Mod+Shift+F formats while the
  // editor has the focus and searches the sidebar elsewhere (#90 precedence).
  "editor.format": {
    scope: "editor",
    defaultShortcut: "Mod+I",
    alternates: ["Mod+Shift+F"],
    shadows: ["sidebar.search"],
  },
  "editor.comment": { scope: "editor", defaultShortcut: "Mod+/" },
  "grid.commit": { scope: "tableTab", defaultShortcut: "Mod+S" },
  // Spec §5.3: Ctrl+Space as TablePlus Linux (literal Ctrl: Cmd+Space is Spotlight on macOS),
  // and Space in the grid (a fixed key of DataGrid: the grammar needs a modifier). Ctrl+I
  // is the spec's add row key (Task 6).
  "grid.rowDetails": { scope: "tableTab", defaultShortcut: "Ctrl+Space" },
  // Spec §5.3: Alt+1 / Alt+2, and Ctrl+Alt+[ / ] (TablePlus ⌃⌘[ / ]) on macOS only, as ⌘⌥[ / ]
  // (Ctrl+Mod would be Ctrl+[ elsewhere): off macOS Ctrl+Alt is AltGr (#102).
  "grid.viewData": { scope: "tableTab", defaultShortcut: "Alt+1", mac: { alternates: ["Mod+Alt+["] } },
  "grid.viewStructure": { scope: "tableTab", defaultShortcut: "Alt+2", mac: { alternates: ["Mod+Alt+]"] } },
  // #103: the third view. [ / ] are a pair with no third key, so Alt+3 alone (Option+3 on
  // macOS, matched by physical key like Alt+1 / Alt+2).
  "grid.viewIndex": { scope: "tableTab", defaultShortcut: "Alt+3" },
  // #90: Ctrl++ (Shift+= on US / AZERTY) and the numpad's + / − too. AZERTY's "-" is the
  // Digit6 key, which matches tab.goto6 by position (layout-aware punctuation is #105).
  "font.increase": { scope: "global", defaultShortcut: "Mod+=", alternates: ["Mod+Shift+=", "Mod+NumpadAdd"] },
  "font.decrease": { scope: "global", defaultShortcut: "Mod+-", alternates: ["Mod+NumpadSubtract"] },
  "database.open": { scope: "global", defaultShortcut: "Mod+K" },
  "editor.open": { scope: "global", defaultShortcut: "Mod+E" },
  "workspace.reload": { scope: "global", defaultShortcut: "Mod+R" },
  "workspace.previous": { scope: "global", defaultShortcut: "Mod+Shift+[", alternates: ["Mod+Shift+PageUp"] },
  "workspace.next": { scope: "global", defaultShortcut: "Mod+Shift+]", alternates: ["Mod+Shift+PageDown"] },
  "sidebar.toggle": { scope: "global", defaultShortcut: "Mod+0" },
  "sidebar.search": { scope: "global", defaultShortcut: "Mod+Shift+F" },
  // Task 4: back / forward in the workspace's history; in a table tab showing its rows, back
  // first goes along the foreign key trail (the former `grid.back`).
  "nav.back": { scope: "global", defaultShortcut: "Alt+ArrowLeft" },
  "nav.forward": { scope: "global", defaultShortcut: "Alt+ArrowRight" },
  "tab.goto1": { scope: "global", defaultShortcut: "Mod+1" },
  "tab.goto2": { scope: "global", defaultShortcut: "Mod+2" },
  "tab.goto3": { scope: "global", defaultShortcut: "Mod+3" },
  "tab.goto4": { scope: "global", defaultShortcut: "Mod+4" },
  "tab.goto5": { scope: "global", defaultShortcut: "Mod+5" },
  "tab.goto6": { scope: "global", defaultShortcut: "Mod+6" },
  "tab.goto7": { scope: "global", defaultShortcut: "Mod+7" },
  "tab.goto8": { scope: "global", defaultShortcut: "Mod+8" },
  "tab.goto9": { scope: "global", defaultShortcut: "Mod+9" },
  // Task 5, grid keys: DataGrid matches them in its own keydown, so they act only while the
  // grid has the focus (never in a field, the editor or the cell editor). Enter (Quick
  // Look), Space (row details) and Delete (delete rows) are fixed keys of the grid.
  "grid.setValue": { scope: "tableTab", defaultShortcut: "Alt+Enter" },
  "grid.copyCells": { scope: "tableTab", defaultShortcut: "Mod+Shift+C" },
  "grid.duplicateRows": { scope: "tableTab", defaultShortcut: "Mod+D" },
  "grid.deleteRows": { scope: "tableTab", defaultShortcut: "Mod+Backspace" },
  // Task 6, the bottom bar (spec §5.3). + Row, Filters and Columns act in the table tab
  // but not in a text field; the page keys only while the grid has the focus (DataGrid
  // matches them, so Mod+← / Mod+→ keep their word moves in fields).
  "grid.addRow": { scope: "tableTab", defaultShortcut: "Mod+I" },
  "grid.filters": { scope: "tableTab", defaultShortcut: "Mod+F" },
  // TablePlus ⌘⌥F on macOS; Alt+F elsewhere, where Ctrl+Alt+F is AltGr+F (#102).
  "grid.columns": { scope: "tableTab", defaultShortcut: "Alt+F", mac: { defaultShortcut: "Mod+Alt+F" } },
  "grid.previousPage": { scope: "tableTab", defaultShortcut: "Mod+ArrowLeft" },
  "grid.nextPage": { scope: "tableTab", defaultShortcut: "Mod+ArrowRight" },
  // The filter bar (FilterBar matches them while the focus is in it).
  "filters.toggle": { scope: "filterBar", defaultShortcut: "Mod+B" },
  "filters.add": { scope: "filterBar", defaultShortcut: "Mod+I" },
  "filters.remove": { scope: "filterBar", defaultShortcut: "Mod+Shift+I" },
  "filters.applyAll": { scope: "filterBar", defaultShortcut: "Mod+Enter" },
  "filters.applyAllOr": { scope: "filterBar", defaultShortcut: "Mod+Shift+Enter" },
  // #103: Up / Down between the rows, and jumps to the row's column and operator pickers.
  // macOS uses ⌘← / ⌘→ for the jumps; elsewhere Ctrl+← / Ctrl+→ stay word moves in the
  // value field, so Alt+C / Alt+O (layout letters).
  "filters.up": { scope: "filterBar", defaultShortcut: "Mod+ArrowUp" },
  "filters.down": { scope: "filterBar", defaultShortcut: "Mod+ArrowDown" },
  "filters.column": { scope: "filterBar", defaultShortcut: "Alt+C", mac: { defaultShortcut: "Mod+ArrowLeft" } },
  "filters.operator": { scope: "filterBar", defaultShortcut: "Alt+O", mac: { defaultShortcut: "Mod+ArrowRight" } },
  // Task 8 (spec §5.3 / §5.5): ⌘⇧K shows the connection list, ⌘N a new connection's form,
  // from anywhere; ⌘F searches the list while it is on screen.
  "connection.open": { scope: "global", defaultShortcut: "Mod+Shift+K" },
  "connection.new": { scope: "global", defaultShortcut: "Mod+N" },
  "connections.search": { scope: "connectionList", defaultShortcut: "Mod+F" },
  // #90, the rest of spec §5.3: Discard / Preview the pending changes of the table tab (the
  // toolbar's buttons), reload the table tab only (⌥⌘R; Alt+R off macOS, #102), reconnect a
  // disconnected workspace, and the editor's completion (literal Ctrl: Cmd+Space is
  // Spotlight; CodeMirror's own Ctrl-Space is replaced by it).
  "grid.discard": { scope: "tableTab", defaultShortcut: "Mod+Shift+Backspace" },
  "grid.preview": { scope: "tableTab", defaultShortcut: "Mod+Shift+P" },
  "tab.reload": { scope: "tableTab", defaultShortcut: "Alt+R", mac: { defaultShortcut: "Mod+Alt+R" } },
  "workspace.reconnect": { scope: "global", defaultShortcut: "Mod+Shift+R" },
  "editor.complete": { scope: "editor", defaultShortcut: "Ctrl+Space" },
} as const satisfies Record<keyof typeof strings.keymap, Spec>;

export type KeymapActionId = keyof typeof SPECS;

export interface KeymapAction {
  id: KeymapActionId;
  /** From `strings.keymap`. */
  label: string;
  scope: ShortcutScope;
  /** Canonical spec (see `isValidShortcut`) off macOS; `defaultShortcut()` gives each platform's. */
  defaultShortcut: string;
}

export const KEYMAP_ACTIONS: readonly KeymapAction[] = (Object.keys(SPECS) as KeymapActionId[]).map((id) => ({
  id,
  label: strings.keymap[id],
  scope: SPECS[id].scope,
  defaultShortcut: SPECS[id].defaultShortcut,
}));

/** The defaults off macOS (Linux, Windows); `defaultShortcut()` gives each platform's. */
export const DEFAULT_KEYMAP: Record<KeymapActionId, string> = Object.fromEntries(
  KEYMAP_ACTIONS.map((a) => [a.id, a.defaultShortcut]),
) as Record<KeymapActionId, string>;

/** The default combination of `id` on this platform (or on macOS / elsewhere with `mac`). */
export function defaultShortcut(id: KeymapActionId, mac: boolean = isMac()): string {
  const spec: Spec = SPECS[id];
  return (mac ? spec.mac?.defaultShortcut : undefined) ?? spec.defaultShortcut;
}

/** The default alternates of `id` on this platform (or on macOS / elsewhere with `mac`). */
function defaultAlternates(id: KeymapActionId, mac: boolean): readonly string[] {
  const spec: Spec = SPECS[id];
  return (mac ? spec.mac?.alternates : undefined) ?? spec.alternates ?? [];
}

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
  "PageUp",
  "PageDown",
  "NumpadAdd",
  "NumpadSubtract",
]);
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;
const CHAR_KEY = /^[A-Z0-9,./;\-=[\]\\`]$/;

/**
 * The canonical shortcut grammar (mirrored by `is_valid_shortcut` in
 * src-tauri/src/settings.rs): `Modifier+…+Key`, modifiers among Mod, Ctrl, Meta, Alt,
 * Shift, each at most once, in any order; Key = one uppercase ASCII letter or digit, one
 * of `, . / ; - = [ ] \ \``, or a named key (Enter, Tab, Escape, Space, Backspace, Delete,
 * ArrowUp/Down/Left/Right, PageUp/PageDown, NumpadAdd/NumpadSubtract, F1–F12). At least one of Mod, Ctrl, Meta, Alt unless the key is
 * F1–F12 (Shift alone would take an uppercase letter or reverse Tab away from typing and focus
 * navigation); at most 32 characters. Everything it accepts, `matchShortcut` can match.
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
  return fn || [...seen].some((m) => m !== "Shift");
}

/** The combination `id` uses: its keymap entry when that is a valid spec, else its default. */
export function effectiveShortcut(id: KeymapActionId, keymap: Record<string, string>, mac: boolean = isMac()): string {
  const custom = own(keymap, id) ? keymap[id] : undefined;
  return typeof custom === "string" && isValidShortcut(custom) ? custom : defaultShortcut(id, mac);
}

/**
 * Every combination `id` answers to: its keymap entry when that is a valid spec, else its
 * default followed by its alternates.
 */
export function effectiveShortcuts(id: KeymapActionId, keymap: Record<string, string>, mac: boolean = isMac()): string[] {
  const custom = own(keymap, id) ? keymap[id] : undefined;
  if (typeof custom === "string" && isValidShortcut(custom)) return [custom];
  return [defaultShortcut(id, mac), ...defaultAlternates(id, mac)];
}

/**
 * The alternates of `id` that are bound: its default alternates, or none once a valid
 * custom shortcut replaces them (for an action whose alternates act differently from its
 * main combination: `tab.next` / `tab.previous`).
 */
export function alternateShortcuts(id: KeymapActionId, keymap: Record<string, string>, mac: boolean = isMac()): string[] {
  const custom = own(keymap, id) ? keymap[id] : undefined;
  if (typeof custom === "string" && isValidShortcut(custom)) return [];
  return [...defaultAlternates(id, mac)];
}

/**
 * The scopes that own a focus region: while the focus is inside the region (the element
 * carries `data-shortcut-scope="<scope>"`, see `FOCUS_SCOPE_ATTR`), an action of that scope
 * wins over any other action bound to the same keys, global ones included (spec §5.5
 * amendment #90). The grid needs no region: DataGrid matches its keys in its own keydown
 * and stops them there.
 */
export const FOCUS_SCOPES: readonly ShortcutScope[] = ["editor", "filterBar"];
/** The attribute that marks a focus region (`data-shortcut-scope`). */
export const FOCUS_SCOPE_ATTR = "data-shortcut-scope";

/** The actions of `scope`, in registry order. */
export function actionsOfScope(scope: ShortcutScope): KeymapActionId[] {
  return KEYMAP_ACTIONS.filter((a) => a.scope === scope).map((a) => a.id);
}

/** Does one of `a` / `b` declare that it shadows the other inside its focus scope? */
export function shadowPair(a: KeymapActionId, b: KeymapActionId): boolean {
  const sa: Spec = SPECS[a];
  const sb: Spec = SPECS[b];
  return (sa.shadows?.includes(b) ?? false) || (sb.shadows?.includes(a) ?? false);
}

/** Two scopes can be active for the same keydown (see `ShortcutScope`). */
function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === b || a === "global" || b === "global") return true;
  // `filterBar` overlaps nothing else: it shadows the table tab inside the bar;
  // `connectionList` neither: no tab is on screen with the connection list.
  return (a === "editor" && b === "queryTab") || (a === "queryTab" && b === "editor");
}

/** The physical combination of a valid spec, `Mod` resolved for the platform. */
function combination(spec: string, mac: boolean): string {
  const parts = spec.split("+");
  const key = parts.pop() as string;
  const mods = new Set(parts.map((m) => (m === "Mod" ? (mac ? "Meta" : "Ctrl") : m)));
  return [...["Ctrl", "Meta", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("+");
}

/** Do two valid specs press the same physical keys on this platform (Mod = Cmd on macOS, Ctrl elsewhere)? */
export function sameCombination(a: string, b: string, mac: boolean = isMac()): boolean {
  return isValidShortcut(a) && isValidShortcut(b) && combination(a, mac) === combination(b, mac);
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
    if (other.id === id || !scopesOverlap(scope, other.scope) || shadowPair(id, other.id)) continue;
    if (effectiveShortcuts(other.id, keymap, mac).some((s) => combination(s, mac) === wanted)) return other.id;
  }
  return null;
}

/**
 * `conflictFor` on this platform, then on the other one (Mod = Cmd on macOS, Ctrl on
 * Linux/Windows): a keymap stays free of conflicts when the settings move to another
 * machine (Meta+T recorded on Linux is Mod+T on macOS). The Settings dialog checks with it.
 */
export function conflictAnywhere(
  id: KeymapActionId,
  spec: string,
  keymap: Record<string, string>,
): KeymapActionId | null {
  const mac = isMac();
  return conflictFor(id, spec, keymap, mac) ?? conflictFor(id, spec, keymap, !mac);
}
