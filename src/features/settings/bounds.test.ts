import { expect, test } from "vitest";
import { KEYMAP_ACTIONS } from "../../lib/keymapRegistry";
import { KEYMAP_MAX_ENTRIES, cleanKeymap, isValidFontFamily } from "./bounds";

test("font family accepts plain and quoted comma-separated names", () => {
  for (const ok of [
    "",
    "Fira Code",
    '"Fira Code", monospace',
    "JetBrains Mono, monospace",
    "'Source Code Pro',monospace",
    "my_font-2",
    "a".repeat(200),
  ]) {
    expect(isValidFontFamily(ok), ok).toBe(true);
  }
});

test("font family rejects CSS syntax, stray quotes and overlong text", () => {
  for (const bad of [
    "x; } .a { color: red",
    "url(x)",
    "a:b",
    '"Fira',
    "'Fira\"",
    "Fira'",
    "a/b",
    "a\\b",
    "<b>",
    "a{b}",
    "a,,b",
    "a,",
    "   ",
    '""',
    '"a"b',
    "Fira\nCode",
    "Fíra",
    "a".repeat(201),
  ]) {
    expect(isValidFontFamily(bad), bad).toBe(false);
  }
});

test("cleanKeymap keeps known ids with valid specs only (mirrors Settings::clamped)", () => {
  expect(
    cleanKeymap(
      JSON.parse(
        '{"editor.run":"Mod+Shift+R","grid.commit":"Mod-S","unknown.action":"Mod+U",' +
          '"query.new":"Mod+<script>","tab.close":5,"__proto__":"Mod+P","constructor":"Mod+C"}',
      ),
    ),
  ).toEqual({ "editor.run": "Mod+Shift+R" });
});

test("cleanKeymap gives an empty keymap for anything but an object", () => {
  for (const bad of [null, undefined, "Mod+K", 3, ["editor.run"]]) {
    expect(cleanKeymap(bad), String(bad)).toEqual({});
  }
});

test("cleanKeymap keeps at most the cap", () => {
  const all = Object.fromEntries(KEYMAP_ACTIONS.map((a) => [a.id, "F5"]));
  expect(Object.keys(cleanKeymap(all))).toHaveLength(KEYMAP_ACTIONS.length);
  expect(Object.keys(cleanKeymap(all, 2))).toHaveLength(2);
  const junk = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`x${i}`, "Mod+K"]));
  expect(cleanKeymap(junk)).toEqual({});
  expect(KEYMAP_ACTIONS.length).toBeLessThanOrEqual(KEYMAP_MAX_ENTRIES);
});
