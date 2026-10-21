import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Tailwind 4: `outline-none` sets `--tw-outline-style: none`, and `outline-2` (or a bare
// `outline`) draws `outline-style: var(--tw-outline-style)`, so a focus ring written as
// `outline-none focus-visible:outline-2` draws nothing unless the same variant also sets
// `outline-solid` (Task 2, Task 11). Read as text: class strings in the sources.

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/** `<variants>:outline`, `<variants>:outline-2`, `<variants>:outline-[3px]`. */
const WIDTH = /^(.+:)outline(?:-\d+(?:\.\d+)?|-\[[^\]]+\])?$/;
const STYLE = /^outline-(?:solid|dashed|dotted|double)$/;

/** The class strings that drop the outline style, then draw one in a variant without setting it. */
function ringsWithoutStyle(text: string): string[] {
  const out: string[] = [];
  for (const literal of text.match(LITERAL) ?? []) {
    const tokens = literal.slice(1, -1).split(/[\s"'`{}$]+/);
    if (!tokens.includes("outline-none")) continue;
    for (const t of tokens) {
      const variant = t.match(WIDTH)?.[1];
      if (!variant) continue;
      const styled = tokens.some((u) => u.startsWith(variant) && STYLE.test(u.slice(variant.length)));
      if (!styled) out.push(`${t} in ${literal.slice(0, 80)}…`);
    }
  }
  return out;
}

test("ringsWithoutStyle finds an outline width without its style", () => {
  expect(ringsWithoutStyle('"a outline-none focus-visible:outline-2 focus-visible:outline-accent"')).toHaveLength(1);
  expect(ringsWithoutStyle('"outline-none focus-visible:outline"')).toHaveLength(1);
  expect(ringsWithoutStyle('"outline-none focus-visible:outline-2 focus-visible:outline-solid"')).toEqual([]);
  expect(ringsWithoutStyle('"outline-none focus-visible:-outline-offset-2 focus-visible:outline-accent"')).toEqual([]);
  // Without outline-none the default style (solid) applies.
  expect(ringsWithoutStyle('"focus-visible:outline-2"')).toEqual([]);
});

test("focus_ring_visible: every outline-none focus ring also sets outline-solid", () => {
  const bad = sources("src").flatMap((f) => ringsWithoutStyle(readFileSync(f, "utf8")).map((m) => `${f}: ${m}`));
  expect(bad).toEqual([]);
});
