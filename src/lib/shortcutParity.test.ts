import { expect, test } from "vitest";
import {
  KEYMAP_ACTIONS,
  type KeymapActionId,
  type ShortcutScope,
  conflictFor,
  defaultShortcut,
  effectiveShortcuts,
  isValidShortcut,
} from "./keymapRegistry";

/**
 * The spec's §5.3 table (TablePlus macOS → TableMax), copied as test data, with the
 * amendments: #102 (no Ctrl+Alt default off macOS: Columns = Alt+F, Data / Structure =
 * Alt+1 / Alt+2, Reload tab = Alt+R; ⌘⌥ stays on macOS), #88 (⌘N is a new connection: the
 * app has connections, not separate workspace windows) and #90 (Beautify's Ctrl+Shift+F in
 * the editor, font size alternates, Discard / Preview / Reload tab / Reconnect / Completion).
 *
 * The spec's contexts map to the registry's scopes: "global" → `global`; "grille" (the table
 * tab and its grid) → `tableTab`; "éditeur" → `editor`; "barre de filtres" → `filterBar`.
 * `linux` is every default combination off macOS (default first, then the alternates),
 * `mac` the same on macOS when it differs.
 */
interface Row {
  row: string;
  id: KeymapActionId;
  scope: ShortcutScope;
  linux: string[];
  mac?: string[];
}

const SPEC_5_3: Row[] = [
  { row: "Préférences", id: "settings.open", scope: "global", linux: ["Mod+,"] },
  { row: "Nouvel onglet SQL", id: "query.new", scope: "global", linux: ["Mod+T"] },
  { row: "Ouvrir l'éditeur", id: "editor.open", scope: "global", linux: ["Mod+E"] },
  { row: "Fermer l'onglet", id: "tab.close", scope: "global", linux: ["Mod+W"] },
  // Ctrl+Tab keeps the most recent order; Ctrl+[ / ] (and PageUp / PageDown, §5.5) the bar's.
  { row: "Onglet précédent", id: "tab.previous", scope: "global", linux: ["Ctrl+Shift+Tab", "Mod+[", "Mod+PageUp"] },
  { row: "Onglet suivant", id: "tab.next", scope: "global", linux: ["Ctrl+Tab", "Mod+]", "Mod+PageDown"] },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(
    (n): Row => ({ row: `Onglet ${n}`, id: `tab.goto${n}`, scope: "global", linux: [`Mod+${n}`] }),
  ),
  { row: "Workspace précédent", id: "workspace.previous", scope: "global", linux: ["Mod+Shift+[", "Mod+Shift+PageUp"] },
  { row: "Workspace suivant", id: "workspace.next", scope: "global", linux: ["Mod+Shift+]", "Mod+Shift+PageDown"] },
  { row: "Open Anything", id: "palette.all", scope: "global", linux: ["Mod+P"] },
  { row: "Ouvrir une base", id: "database.open", scope: "global", linux: ["Mod+K"] },
  { row: "Ouvrir une connexion", id: "connection.open", scope: "global", linux: ["Mod+Shift+K"] },
  { row: "Barre latérale", id: "sidebar.toggle", scope: "global", linux: ["Mod+0"] },
  // Literal Ctrl (Cmd+Space is Spotlight); Space in the grid is a fixed key (FIXED_KEYS).
  { row: "Panneau de détail", id: "grid.rowDetails", scope: "tableTab", linux: ["Ctrl+Space"] },
  { row: "Chercher dans la barre latérale", id: "sidebar.search", scope: "global", linux: ["Mod+Shift+F"] },
  { row: "Data", id: "grid.viewData", scope: "tableTab", linux: ["Alt+1"], mac: ["Alt+1", "Mod+Alt+["] },
  { row: "Structure", id: "grid.viewStructure", scope: "tableTab", linux: ["Alt+2"], mac: ["Alt+2", "Mod+Alt+]"] },
  { row: "Précédent (navigation)", id: "nav.back", scope: "global", linux: ["Alt+ArrowLeft"] },
  { row: "Suivant (navigation)", id: "nav.forward", scope: "global", linux: ["Alt+ArrowRight"] },
  { row: "Filtres", id: "grid.filters", scope: "tableTab", linux: ["Mod+F"] },
  { row: "Colonnes", id: "grid.columns", scope: "tableTab", linux: ["Alt+F"], mac: ["Mod+Alt+F"] },
  { row: "Activer / désactiver un filtre", id: "filters.toggle", scope: "filterBar", linux: ["Mod+B"] },
  { row: "Appliquer tous (AND)", id: "filters.applyAll", scope: "filterBar", linux: ["Mod+Enter"] },
  { row: "Appliquer tous (OR)", id: "filters.applyAllOr", scope: "filterBar", linux: ["Mod+Shift+Enter"] },
  { row: "Page précédente", id: "grid.previousPage", scope: "tableTab", linux: ["Mod+ArrowLeft"] },
  { row: "Page suivante", id: "grid.nextPage", scope: "tableTab", linux: ["Mod+ArrowRight"] },
  { row: "Commit", id: "grid.commit", scope: "tableTab", linux: ["Mod+S"] },
  // ⌘S in a SQL tab saves the query (same keys, never on screen together).
  { row: "Commit (onglet SQL : enregistrer)", id: "query.save", scope: "queryTab", linux: ["Mod+S"] },
  { row: "Discard", id: "grid.discard", scope: "tableTab", linux: ["Mod+Shift+Backspace"] },
  { row: "Preview", id: "grid.preview", scope: "tableTab", linux: ["Mod+Shift+P"] },
  { row: "Ajouter une ligne", id: "grid.addRow", scope: "tableTab", linux: ["Mod+I"] },
  // ⌘I adds a condition inside the filter bar (TablePlus reuses it there).
  { row: "Ajouter (barre de filtres)", id: "filters.add", scope: "filterBar", linux: ["Mod+I"] },
  { row: "Dupliquer une ligne", id: "grid.duplicateRows", scope: "tableTab", linux: ["Mod+D"] },
  // Delete is a fixed key of the grid (FIXED_KEYS).
  { row: "Supprimer les lignes", id: "grid.deleteRows", scope: "tableTab", linux: ["Mod+Backspace"] },
  { row: "Copier les cellules sélectionnées", id: "grid.copyCells", scope: "tableTab", linux: ["Mod+Shift+C"] },
  // Enter (Quick Look) is a fixed key of the grid (FIXED_KEYS).
  { row: "Set value", id: "grid.setValue", scope: "tableTab", linux: ["Alt+Enter"] },
  { row: "Exécuter la requête courante", id: "editor.run", scope: "editor", linux: ["Mod+Enter"] },
  { row: "Exécuter tout", id: "editor.runAll", scope: "editor", linux: ["Mod+Shift+Enter"] },
  { row: "Commenter", id: "editor.comment", scope: "editor", linux: ["Mod+/"] },
  // "Ctrl+Shift+F reste aussi": in the editor only, where it wins over the sidebar search.
  { row: "Beautify", id: "editor.format", scope: "editor", linux: ["Mod+I", "Mod+Shift+F"] },
  // Ctrl++ (Shift+=) and the numpad's + / − as well.
  { row: "Taille de police +", id: "font.increase", scope: "global", linux: ["Mod+=", "Mod+Shift+=", "Mod+NumpadAdd"] },
  { row: "Taille de police −", id: "font.decrease", scope: "global", linux: ["Mod+-", "Mod+NumpadSubtract"] },
  { row: "Recharger", id: "workspace.reload", scope: "global", linux: ["Mod+R"] },
  // ⌥⌘R: Alt+R off macOS, where Ctrl+Alt is AltGr (#102).
  { row: "Recharger l'onglet", id: "tab.reload", scope: "tableTab", linux: ["Alt+R"], mac: ["Mod+Alt+R"] },
  { row: "Reconnecter", id: "workspace.reconnect", scope: "global", linux: ["Mod+Shift+R"] },
  // #88: ⌘N opens a new connection's form (TableMax has no separate workspace windows).
  { row: "Nouveau workspace", id: "connection.new", scope: "global", linux: ["Mod+N"] },
  // Literal Ctrl, as TablePlus (Cmd+Space is Spotlight).
  { row: "Complétion", id: "editor.complete", scope: "editor", linux: ["Ctrl+Space"] },
];

/**
 * Keys of the §5.3 table that are fixed keys of the grid, not keymap entries: the grammar
 * needs a modifier (a bare key would be taken from typing), so they cannot be rebound.
 */
const FIXED_KEYS = [
  { row: "Panneau de détail", key: "Space" },
  { row: "Quick Look", key: "Enter" },
  { row: "Supprimer les lignes", key: "Delete" },
];

/** Registry actions that are not in the §5.3 table (each from another part of the spec). */
const OUTSIDE_5_3: KeymapActionId[] = [
  "history.toggle", // §5.5 Colonne des connexions
  "grid.viewIndex", // #103 third view
  "filters.remove", // #102
  "filters.up", // #103
  "filters.down", // #103
  "filters.column", // #103
  "filters.operator", // #103
  "connections.search", // #88
];

test("every_spec_shortcut_registered_with_default: each §5.3 row has its action, scope and defaults", () => {
  for (const r of SPEC_5_3) {
    const action = KEYMAP_ACTIONS.find((a) => a.id === r.id);
    expect(action, `${r.row}: ${r.id}`).toBeDefined();
    expect(action?.scope, `${r.row}: scope`).toBe(r.scope);
    expect(effectiveShortcuts(r.id, {}, false), `${r.row}: off macOS`).toEqual(r.linux);
    expect(effectiveShortcuts(r.id, {}, true), `${r.row}: macOS`).toEqual(r.mac ?? r.linux);
    expect(defaultShortcut(r.id, false)).toBe(r.linux[0]);
    expect(defaultShortcut(r.id, true)).toBe((r.mac ?? r.linux)[0]);
  }
});

test("the §5.3 defaults are valid and free of conflicts on both platforms", () => {
  for (const r of SPEC_5_3) {
    for (const mac of [false, true]) {
      for (const spec of r.mac && mac ? r.mac : r.linux) {
        expect(isValidShortcut(spec), `${r.row} ${spec}`).toBe(true);
        expect(conflictFor(r.id, spec, {}, mac), `${r.row} ${spec}`).toBeNull();
      }
    }
  }
});

test("the registry has no action outside the §5.3 table but the listed ones", () => {
  const listed = [...SPEC_5_3.map((r) => r.id), ...OUTSIDE_5_3];
  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual(KEYMAP_ACTIONS.map((a) => a.id).sort());
});

test("the grid's fixed keys cannot be keymap entries (a bare key would take typing away)", () => {
  for (const f of FIXED_KEYS) expect(isValidShortcut(f.key), f.row).toBe(false);
});
