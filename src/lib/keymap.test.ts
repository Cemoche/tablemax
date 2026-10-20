import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, useSettings } from "../stores/settings";
import fixture from "./keymap-actions.json";
import {
  DEFAULT_KEYMAP,
  KEYMAP_ACTIONS,
  type KeymapActionId,
  conflictAnywhere,
  alternateShortcuts,
  conflictFor,
  defaultShortcut,
  effectiveShortcut,
  effectiveShortcuts,
  isKeymapActionId,
  isValidShortcut,
  useAction,
  useEffectiveShortcut,
} from "./keymap";
import { matchShortcut } from "./shortcuts";

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS, confirmed: DEFAULT_SETTINGS });
});

test("the registry's ids are the shared fixture, in order (src-tauri settings.rs checks the same file)", () => {
  expect(KEYMAP_ACTIONS.map((a) => a.id)).toEqual(fixture);
  expect(Object.keys(DEFAULT_KEYMAP)).toEqual(fixture);
});

test("the defaults are the combinations the code binds today", () => {
  expect(DEFAULT_KEYMAP).toEqual({
    "query.new": "Mod+T",
    "tab.close": "Mod+W",
    "tab.next": "Ctrl+Tab",
    "tab.previous": "Ctrl+Shift+Tab",
    "palette.all": "Mod+P",
    "settings.open": "Mod+,",
    "query.save": "Mod+S",
    "history.toggle": "Mod+Shift+H",
    "editor.run": "Mod+Enter",
    "editor.runAll": "Mod+Shift+Enter",
    "editor.format": "Mod+I",
    "editor.comment": "Mod+/",
    "grid.commit": "Mod+S",
    "grid.rowDetails": "Ctrl+Space",
    "grid.viewData": "Alt+1",
    "grid.viewStructure": "Alt+2",
    "grid.viewIndex": "Alt+3",
    "font.increase": "Mod+=",
    "font.decrease": "Mod+-",
    "database.open": "Mod+K",
    "editor.open": "Mod+E",
    "workspace.reload": "Mod+R",
    "workspace.previous": "Mod+Shift+[",
    "workspace.next": "Mod+Shift+]",
    "sidebar.toggle": "Mod+0",
    "sidebar.search": "Mod+Shift+F",
    "nav.back": "Alt+ArrowLeft",
    "nav.forward": "Alt+ArrowRight",
    "tab.goto1": "Mod+1",
    "tab.goto2": "Mod+2",
    "tab.goto3": "Mod+3",
    "tab.goto4": "Mod+4",
    "tab.goto5": "Mod+5",
    "tab.goto6": "Mod+6",
    "tab.goto7": "Mod+7",
    "tab.goto8": "Mod+8",
    "tab.goto9": "Mod+9",
    "grid.setValue": "Alt+Enter",
    "grid.copyCells": "Mod+Shift+C",
    "grid.duplicateRows": "Mod+D",
    "grid.deleteRows": "Mod+Backspace",
    "grid.addRow": "Mod+I",
    "grid.filters": "Mod+F",
    "grid.columns": "Alt+F",
    "grid.previousPage": "Mod+ArrowLeft",
    "grid.nextPage": "Mod+ArrowRight",
    "filters.toggle": "Mod+B",
    "filters.add": "Mod+I",
    "filters.remove": "Mod+Shift+I",
    "filters.applyAll": "Mod+Enter",
    "filters.applyAllOr": "Mod+Shift+Enter",
  });
  const scope = (id: KeymapActionId) => KEYMAP_ACTIONS.find((a) => a.id === id)?.scope;
  expect(scope("query.new")).toBe("global");
  expect(scope("query.save")).toBe("queryTab");
  // Task 3: Ctrl+Shift+H opens the sidebar's History tab, from anywhere in a workspace.
  expect(scope("history.toggle")).toBe("global");
  expect(scope("editor.format")).toBe("editor");
  expect(scope("grid.commit")).toBe("tableTab");
  // Task 5: grid keys (the grid acts on them only while it has the focus).
  for (const id of ["grid.setValue", "grid.copyCells", "grid.duplicateRows", "grid.deleteRows"] as const) {
    expect(scope(id), id).toBe("tableTab");
  }
  // Task 4: Alt+← / Alt+→ walk the workspace's history (and first the foreign key trail of a
  // table tab, which `grid.back` did alone before).
  expect(scope("nav.back")).toBe("global");
  expect(scope("nav.forward")).toBe("global");
  expect(scope("tab.goto1")).toBe("global");
  expect(isKeymapActionId("grid.back")).toBe(false);
  // Task 6: the bottom bar's keys act in the table tab; the filter bar's only in the bar.
  for (const id of ["grid.addRow", "grid.filters", "grid.columns", "grid.previousPage", "grid.nextPage"] as const) {
    expect(scope(id), id).toBe("tableTab");
  }
  for (const id of ["filters.toggle", "filters.add", "filters.remove", "filters.applyAll", "filters.applyAllOr"] as const) {
    expect(scope(id), id).toBe("filterBar");
  }
  expect(scope("font.increase")).toBe("global");
  expect(scope("font.decrease")).toBe("global");
  expect(scope("database.open")).toBe("global");
  expect(scope("editor.open")).toBe("global");
  expect(scope("workspace.reload")).toBe("global");
  expect(scope("workspace.previous")).toBe("global");
  expect(scope("workspace.next")).toBe("global");
  expect(scope("sidebar.toggle")).toBe("global");
  expect(scope("sidebar.search")).toBe("global");
  for (const a of KEYMAP_ACTIONS) expect(a.label, a.id).not.toBe("");
});

test("every default is valid and no two defaults conflict, on either platform", () => {
  for (const mac of [false, true]) {
    for (const a of KEYMAP_ACTIONS) {
      for (const spec of effectiveShortcuts(a.id, {}, mac)) {
        expect(isValidShortcut(spec), `${a.id} ${spec}`).toBe(true);
        expect(conflictFor(a.id, spec, {}, mac), `${a.id} ${spec}`).toBeNull();
      }
    }
  }
});

test("workspace_shortcuts_cycle: the workspace actions also answer to Mod+Shift+PageUp / PageDown", () => {
  expect(effectiveShortcuts("workspace.previous", {})).toEqual(["Mod+Shift+[", "Mod+Shift+PageUp"]);
  expect(effectiveShortcuts("workspace.next", {})).toEqual(["Mod+Shift+]", "Mod+Shift+PageDown"]);
  // A custom combination replaces the default and its alternates.
  expect(effectiveShortcuts("workspace.next", { "workspace.next": "Alt+N" })).toEqual(["Alt+N"]);
  // An alternate is taken like a default: nothing else may use it.
  expect(conflictFor("query.new", "Mod+Shift+PageUp", {}, false)).toBe("workspace.previous");
  expect(conflictFor("query.new", "Mod+Shift+PageUp", { "workspace.previous": "Alt+P" }, false)).toBeNull();
});

test("ctrl_brackets_and_pageup_cycle_tabs: the tab actions also answer to Mod+[ / ] and Mod+PageUp / PageDown", () => {
  expect(effectiveShortcuts("tab.previous", {})).toEqual(["Ctrl+Shift+Tab", "Mod+[", "Mod+PageUp"]);
  expect(effectiveShortcuts("tab.next", {})).toEqual(["Ctrl+Tab", "Mod+]", "Mod+PageDown"]);
  expect(alternateShortcuts("tab.next", {})).toEqual(["Mod+]", "Mod+PageDown"]);
  // A custom combination replaces the alternates as well.
  expect(alternateShortcuts("tab.next", { "tab.next": "Alt+N" })).toEqual([]);
  expect(alternateShortcuts("tab.next", { "tab.next": "nonsense" })).toEqual(["Mod+]", "Mod+PageDown"]);
  // Without Shift, Mod+[ is not the previous workspace (Mod+Shift+[).
  expect(conflictFor("workspace.previous", "Mod+Shift+[", {}, false)).toBeNull();
  expect(conflictFor("query.new", "Mod+[", {}, false)).toBe("tab.previous");
});

test("useAction binds every effective combination of an action", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const handler = vi.fn();
  renderHook(() => useAction("workspace.next", handler));
  const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", init));
  press({ code: "BracketRight", ctrlKey: true, shiftKey: true });
  press({ code: "PageDown", ctrlKey: true, shiftKey: true });
  expect(handler).toHaveBeenCalledTimes(2);
  act(() =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "workspace.next": "Alt+N" } } }),
  );
  press({ code: "PageDown", ctrlKey: true, shiftKey: true });
  expect(handler).toHaveBeenCalledTimes(2);
  press({ code: "KeyN", altKey: true });
  expect(handler).toHaveBeenCalledTimes(3);
});

test("the grammar accepts canonical ASCII specs", () => {
  for (const ok of [
    "Mod+K",
    "Ctrl+Shift+Tab",
    "Shift+Mod+F",
    "Meta+Alt+Ctrl+Shift+Z",
    "Mod+,",
    "Mod+.",
    "Mod+/",
    "Mod+;",
    "Mod+-",
    "Mod+=",
    "Mod+[",
    "Mod+]",
    "Mod+\\",
    "Mod+`",
    "Alt+1",
    "Ctrl+0",
    "Mod+Enter",
    "Alt+Tab",
    "Ctrl+Escape",
    "Ctrl+Space",
    "Mod+Backspace",
    "Mod+Delete",
    "Alt+ArrowUp",
    "Alt+ArrowDown",
    "Alt+ArrowLeft",
    "Alt+ArrowRight",
    "Ctrl+PageUp",
    "Mod+Shift+PageDown",
    "F5",
    "F12",
    "Shift+F1",
  ]) {
    expect(isValidShortcut(ok), ok).toBe(true);
  }
});

test("the grammar rejects everything else", () => {
  for (const bad of [
    "",
    "K",
    "Enter",
    "1",
    "Mod",
    "Mod+",
    "+K",
    "Mod++",
    "Mod+k",
    "mod+K",
    "Cmd+K",
    "Mod+Mod+K",
    "Ctrl+Shift+Shift+K",
    "Mod-Enter",
    "Mod+KK",
    "Mod+F13",
    "Mod+F0",
    "F",
    "Mod+Home",
    "Mod+é",
    "Mod+ K",
    "Mod+K ",
    "Mod+<",
    "Mod+'",
    `Mod+"`,
    "Ctrl+Meta+Alt+Shift+Mod+ArrowRight+",
    `${"Ctrl+".repeat(6)}K`,
  ]) {
    expect(isValidShortcut(bad), JSON.stringify(bad)).toBe(false);
  }
  // 33 characters, otherwise valid shape.
  expect(isValidShortcut("Meta+Ctrl+Alt+Shift+Mod+Backspace")).toBe(false);
  expect(isValidShortcut("Meta+Ctrl+Alt+Shift+Mod+ArrowUp")).toBe(true);
});

test("Shift alone is not a modifier, except on a function key", () => {
  for (const bad of ["Shift+K", "Shift+Tab", "Shift+1", "Shift+Enter", "Shift+/", "Shift+ArrowUp", "Shift+PageUp", "PageDown"]) {
    expect(isValidShortcut(bad), bad).toBe(false);
  }
  for (const ok of ["Shift+F5", "Mod+Shift+K", "Ctrl+Shift+Tab", "Alt+Shift+1", "Meta+Shift+Enter"]) {
    expect(isValidShortcut(ok), ok).toBe(true);
  }
  for (const spec of Object.values(DEFAULT_KEYMAP)) expect(isValidShortcut(spec), spec).toBe(true);
});

test("every grammar key is matched by matchShortcut", () => {
  const ev = (code: string, mods: Partial<KeyboardEvent> = {}) =>
    new KeyboardEvent("keydown", { code, ctrlKey: true, ...mods });
  expect(matchShortcut(ev("Backslash"), "Ctrl+\\")).toBe(true);
  expect(matchShortcut(ev("Backquote"), "Ctrl+`")).toBe(true);
  expect(matchShortcut(ev("Backspace"), "Ctrl+Backspace")).toBe(true);
  expect(matchShortcut(ev("Delete"), "Ctrl+Delete")).toBe(true);
  expect(matchShortcut(ev("Space"), "Ctrl+Space")).toBe(true);
  expect(matchShortcut(ev("F5", { ctrlKey: false }), "F5")).toBe(true);
  expect(matchShortcut(ev("ArrowLeft", { ctrlKey: false, altKey: true }), "Alt+ArrowLeft")).toBe(true);
  expect(matchShortcut(ev("Digit2", { ctrlKey: false, altKey: true }), "Alt+2")).toBe(true);
  expect(matchShortcut(ev("PageUp"), "Ctrl+PageUp")).toBe(true);
  expect(matchShortcut(ev("PageDown", { shiftKey: true }), "Ctrl+Shift+PageDown")).toBe(true);
});

test("effectiveShortcut takes a valid override and falls back on unknown or invalid entries", () => {
  expect(effectiveShortcut("query.new", {})).toBe("Mod+T");
  expect(effectiveShortcut("query.new", { "query.new": "Mod+Shift+N" })).toBe("Mod+Shift+N");
  expect(effectiveShortcut("query.new", { "query.new": "Mod-N" })).toBe("Mod+T");
  expect(effectiveShortcut("query.new", { "query.new": "" })).toBe("Mod+T");
  expect(effectiveShortcut("query.new", { "query.newer": "Mod+N" })).toBe("Mod+T");
  expect(effectiveShortcut("query.new", { "query.new": 42 } as unknown as Record<string, string>)).toBe("Mod+T");
  // An inherited property is not an override.
  expect(effectiveShortcut("query.new", Object.create({ "query.new": "Mod+N" }))).toBe("Mod+T");
});

test("isKeymapActionId knows the registry ids only", () => {
  expect(isKeymapActionId("editor.format")).toBe(true);
  expect(isKeymapActionId("connection.new")).toBe(false);
  expect(isKeymapActionId("toString")).toBe(false);
});

test("a global combination conflicts with every scope", () => {
  // Mod+K opens a database (global).
  expect(conflictFor("grid.rowDetails", "Mod+K", {}, false)).toBe("database.open");
  expect(conflictFor("query.save", "Mod+K", {}, false)).toBe("database.open");
  expect(conflictFor("editor.run", "Mod+K", {}, false)).toBe("database.open");
  // ...and a global action takes nothing any scope already uses.
  expect(conflictFor("database.open", "Mod+I", {}, false)).toBe("editor.format");
  expect(conflictFor("database.open", "Ctrl+Space", {}, false)).toBe("grid.rowDetails");
  expect(conflictFor("database.open", "Mod+D", {}, false)).toBe("grid.duplicateRows");
  expect(conflictFor("database.open", "Mod+Enter", {}, false)).toBe("editor.run");
  expect(conflictFor("database.open", "Mod+T", {}, false)).toBe("query.new");
});

test("query tabs and table tabs never conflict with each other", () => {
  expect(conflictFor("query.save", "Mod+S", {}, false)).toBeNull();
  expect(conflictFor("grid.commit", "Mod+S", {}, false)).toBeNull();
  expect(conflictFor("query.save", "Alt+1", {}, false)).toBeNull();
  expect(conflictFor("grid.viewData", "Mod+Enter", {}, false)).toBeNull();
});

test("the same scope conflicts with itself", () => {
  expect(conflictFor("grid.viewData", "Alt+2", {}, false)).toBe("grid.viewStructure");
  expect(conflictFor("history.toggle", "Mod+S", {}, false)).toBe("query.save");
  expect(conflictFor("editor.runAll", "Mod+Enter", {}, false)).toBe("editor.run");
});

test("the editor conflicts with its query tab both ways (ruling B-R1), not with table tabs", () => {
  expect(conflictFor("editor.format", "Mod+S", {}, false)).toBe("query.save");
  expect(conflictFor("query.save", "Mod+Enter", {}, false)).toBe("editor.run");
  expect(conflictFor("editor.format", "Mod+I", {}, false)).toBeNull();
  expect(conflictFor("grid.rowDetails", "Mod+/", {}, false)).toBeNull();
  // Completion is Ctrl+Space in the editor (CodeMirror) and Ctrl+Space shows the row details
  // in a table tab (spec §5.3): never active together.
  expect(conflictFor("editor.format", "Ctrl+Space", {}, false)).toBeNull();
  // Mod+I is + Row in a table tab (Task 6), still free for the editor's Beautify.
  expect(conflictFor("grid.rowDetails", "Mod+I", {}, false)).toBe("grid.addRow");
  // Mod+Shift+F searches the sidebar from anywhere, so the editor cannot take it back.
  expect(conflictFor("editor.format", "Mod+Shift+F", {}, false)).toBe("sidebar.search");
});

test("Mod is resolved per platform: Mod+K is Ctrl+K on Linux, not on macOS", () => {
  expect(conflictFor("grid.rowDetails", "Ctrl+K", {}, false)).toBe("database.open");
  expect(conflictFor("grid.rowDetails", "Ctrl+K", {}, true)).toBeNull();
  expect(conflictFor("grid.rowDetails", "Meta+K", {}, true)).toBe("database.open");
  expect(conflictFor("grid.rowDetails", "Meta+K", {}, false)).toBeNull();
  // Modifier order does not matter.
  expect(conflictFor("editor.format", "Shift+Mod+Enter", {}, false)).toBe("editor.runAll");
});

test("conflicts use the effective combinations and ignore the action itself", () => {
  const keymap = { "database.open": "Mod+Shift+K" };
  expect(conflictFor("grid.rowDetails", "Mod+K", keymap, false)).toBeNull();
  expect(conflictFor("grid.rowDetails", "Mod+Shift+K", keymap, false)).toBe("database.open");
  expect(conflictFor("database.open", "Mod+K", {}, false)).toBeNull();
  // An invalid override falls back to the default, which still counts.
  expect(conflictFor("grid.rowDetails", "Mod+K", { "database.open": "bad" }, false)).toBe("database.open");
});

test("conflictAnywhere refuses a combination that conflicts on macOS or on Linux/Windows", () => {
  // Meta+T is free on Linux but is Mod+T (New query) on macOS.
  expect(conflictFor("database.open", "Meta+T", {}, false)).toBeNull();
  expect(conflictAnywhere("database.open", "Meta+T", {})).toBe("query.new");
  // Ctrl+K is free on macOS but is Mod+K (open a database) on Linux.
  expect(conflictFor("grid.rowDetails", "Ctrl+K", {}, true)).toBeNull();
  expect(conflictAnywhere("grid.rowDetails", "Ctrl+K", {})).toBe("database.open");
  // Free on both platforms.
  expect(conflictAnywhere("database.open", "Mod+Shift+K", {})).toBeNull();
  expect(conflictAnywhere("database.open", "Mod+K", {})).toBeNull();
});

test("an invalid combination has no conflict to report", () => {
  expect(conflictFor("grid.rowDetails", "Mod-K", {}, false)).toBeNull();
});

test("useEffectiveShortcut follows the settings' keymap", () => {
  const { result } = renderHook(() => useEffectiveShortcut("grid.commit"));
  expect(result.current).toBe("Mod+S");
  act(() =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "grid.commit": "Mod+Enter" } } }),
  );
  expect(result.current).toBe("Mod+Enter");
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("useAction binds the effective combination: a custom one replaces the default", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const handler = vi.fn();
  renderHook(() => useAction("database.open", handler));
  const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", init));
  press({ code: "KeyK", ctrlKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
  act(() =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "database.open": "Alt+Space" } } }),
  );
  press({ code: "KeyK", ctrlKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
  press({ code: "Space", altKey: true });
  expect(handler).toHaveBeenCalledTimes(2);
});

test("view_switch_alternates: Data / Structure also answer to ⌘⌥[ / ] on macOS only, Alt+1 / Alt+2 everywhere", () => {
  expect(effectiveShortcuts("grid.viewData", {}, true)).toEqual(["Alt+1", "Mod+Alt+["]);
  expect(effectiveShortcuts("grid.viewStructure", {}, true)).toEqual(["Alt+2", "Mod+Alt+]"]);
  // Off macOS Ctrl+Alt is AltGr (#102): no alternate.
  expect(effectiveShortcuts("grid.viewData", {}, false)).toEqual(["Alt+1"]);
  expect(effectiveShortcuts("grid.viewStructure", {}, false)).toEqual(["Alt+2"]);
  // #103: Index is Alt+3 on every platform (no third bracket key for ⌘⌥).
  expect(effectiveShortcuts("grid.viewIndex", {}, false)).toEqual(["Alt+3"]);
  expect(effectiveShortcuts("grid.viewIndex", {}, true)).toEqual(["Alt+3"]);
  expect(effectiveShortcuts("grid.viewData", { "grid.viewData": "Alt+D" }, true)).toEqual(["Alt+D"]);
  // Not the tab keys (Mod+[ / ]) nor the workspace keys (Mod+Shift+[ / ]).
  expect(conflictFor("grid.viewData", "Mod+Alt+[", {}, true)).toBeNull();
  expect(conflictFor("tab.previous", "Mod+Alt+[", {}, true)).toBe("grid.viewData");
  expect(conflictFor("tab.previous", "Mod+Alt+[", {}, false)).toBeNull();
});

test("no Ctrl+Alt default off macOS, where Ctrl+Alt is AltGr; ⌘⌥ stays on macOS (#102)", () => {
  const ctrlAlt = (spec: string, mac: boolean) => {
    const mods = spec.split("+").slice(0, -1).map((m) => (m === "Mod" ? (mac ? "Meta" : "Ctrl") : m));
    return mods.includes("Ctrl") && mods.includes("Alt");
  };
  for (const a of KEYMAP_ACTIONS) {
    for (const spec of effectiveShortcuts(a.id, {}, false)) expect(ctrlAlt(spec, false), `${a.id} ${spec}`).toBe(false);
  }
  expect(defaultShortcut("grid.columns", false)).toBe("Alt+F");
  expect(defaultShortcut("grid.columns", true)).toBe("Mod+Alt+F");
  expect(effectiveShortcut("grid.columns", {}, true)).toBe("Mod+Alt+F");
  expect(effectiveShortcut("grid.columns", { "grid.columns": "Alt+C" }, true)).toBe("Alt+C");
  // The Settings check holds across platforms: Alt+F recorded on macOS is Columns' elsewhere.
  expect(conflictAnywhere("grid.filters", "Alt+F", {})).toBe("grid.columns");
});

test("filter_bar_scope: the bar's keys shadow the table tab's inside the bar, never the editor's", () => {
  // Same keys, never both active: Mod+I adds a filter row in the bar, a table row elsewhere.
  expect(conflictFor("filters.add", "Mod+I", {}, false)).toBeNull();
  expect(conflictFor("grid.addRow", "Mod+I", {}, false)).toBeNull();
  // The editor (query tabs) runs with Mod+Enter / Mod+Shift+Enter; the bar applies with them.
  expect(conflictFor("filters.applyAll", "Mod+Enter", {}, false)).toBeNull();
  expect(conflictFor("editor.run", "Mod+Enter", {}, false)).toBeNull();
  // Inside the bar its own actions conflict with each other, and global keys win everywhere.
  expect(conflictFor("filters.add", "Mod+B", {}, false)).toBe("filters.toggle");
  expect(conflictFor("filters.toggle", "Mod+K", {}, false)).toBe("database.open");
  expect(conflictFor("database.open", "Mod+Shift+I", {}, false)).toBe("filters.remove");
  // Page keys: Mod+← / Mod+→ only in the grid (a text field keeps its word moves).
  expect(conflictFor("grid.columns", "Mod+ArrowLeft", {}, false)).toBe("grid.previousPage");
});
