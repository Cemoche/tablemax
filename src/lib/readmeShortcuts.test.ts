import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { KEYMAP_ACTIONS, effectiveShortcuts } from "./keymapRegistry";
import { formatShortcut } from "./platform";

// The README's shortcut table is written by hand: it must name every default (and
// alternate) of the registry, off macOS, and the macOS ones where they differ.
const readme = readFileSync("README.md", "utf8");
const start = readme.indexOf("## Settings and keyboard shortcuts");
const end = readme.indexOf("\n## ", start + 1);
const section = readme.slice(start, end);
const quoted = new Set([...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]));

test("readme_shortcuts: the README lists every default shortcut", () => {
  expect(start).toBeGreaterThan(-1);
  const missing = KEYMAP_ACTIONS.flatMap((a) =>
    effectiveShortcuts(a.id, {}, false)
      .map((spec) => formatShortcut(spec, false))
      .filter((label) => !quoted.has(label))
      .map((label) => `${a.id}: ${label}`),
  );
  expect(missing).toEqual([]);
});

test("readme_shortcuts: the README's macOS column names the macOS-only defaults", () => {
  const missing = KEYMAP_ACTIONS.flatMap((a) => {
    const mac = effectiveShortcuts(a.id, {}, true);
    const other = effectiveShortcuts(a.id, {}, false);
    if (mac.join() === other.join()) return [];
    return mac
      .filter((spec) => !other.includes(spec))
      .map((spec) => formatShortcut(spec, true))
      .filter((label) => !quoted.has(label))
      .map((label) => `${a.id}: ${label}`);
  });
  expect(missing).toEqual([]);
});
