import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// White text reads 4.0:1 (light) / 3.9:1 (dark) on --accent, under the 4.5:1 of WCAG AA:
// a filled control or highlighted row uses --accent-strong (#103, #107). An opaque --accent
// fill is refused whatever the text colour (the text may come from another string, a
// `cn()` argument or an inherited colour); --accent stays for tints (`bg-accent/30`), focus
// rings, borders and icons. A future fill without text goes to ALLOWED with its reason.
// Read as text, like focusRing.test.ts: class strings, inline styles and CSS in the sources.

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/**
 * An opaque accent fill behind any variants (`hover:`, `data-[…]:`), with or without the
 * important modifier: `bg-accent`, `!bg-accent`, `bg-accent!`, `bg-[var(--accent)]`,
 * `bg-(--color-accent)`… A tint (`bg-accent/30`) and `bg-accent-strong` do not match.
 */
const ACCENT_FILL = /^(?:\S+:)?!?bg-(?:accent|\[var\(--(?:color-)?accent\)\]|\(--(?:color-)?accent\))!?$/;
/** An inline style or CSS rule painting --accent (not --accent-strong) as a background. */
const ACCENT_BG_STYLE = /background(?:-color|Color)?\s*:\s*["'`]?var\(--(?:color-)?accent\)/;

/** Exceptions, "file: token" → reason (a fill that never carries text). None today. */
const ALLOWED: Record<string, string> = {};

/** The opaque --accent fills of a source text. */
function accentFills(text: string): string[] {
  const out: string[] = [];
  for (const literal of text.match(LITERAL) ?? []) {
    for (const t of literal.slice(1, -1).split(/[\s"'`{}$,]+/)) if (ACCENT_FILL.test(t)) out.push(t);
  }
  for (const line of text.split("\n")) if (ACCENT_BG_STYLE.test(line)) out.push(line.trim());
  return out;
}

test("accentFills finds every opaque --accent fill, not tints nor --accent-strong", () => {
  expect(accentFills('"rounded-sm bg-accent px-3 py-1 text-accent-contrast"')).toEqual(["bg-accent"]);
  expect(accentFills('"hover:bg-accent hover:text-accent-contrast"')).toEqual(["hover:bg-accent"]);
  expect(accentFills('"data-[selected=true]:bg-accent"')).toHaveLength(1);
  // Whatever the text colour, or with the text in another string.
  expect(accentFills('cn("bg-accent", "text-white")')).toHaveLength(1);
  expect(accentFills('"bg-accent text-fg"')).toHaveLength(1);
  expect(accentFills('"!bg-accent"')).toHaveLength(1);
  expect(accentFills('"hover:bg-accent!"')).toHaveLength(1);
  expect(accentFills('"bg-[var(--accent)]"')).toHaveLength(1);
  expect(accentFills('"bg-(--color-accent)"')).toHaveLength(1);
  expect(accentFills('{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }')).toHaveLength(1);
  expect(accentFills(".x { background: var(--accent); }")).toHaveLength(1);
  expect(accentFills(".x { background-color: var(--color-accent); }")).toHaveLength(1);
  // The deeper fill, tints, accent borders, rings and icons: fine.
  expect(accentFills('"hover:bg-accent-strong hover:text-accent-contrast"')).toEqual([]);
  expect(accentFills('"hover:bg-accent/30 focus-visible:bg-accent/50"')).toEqual([]);
  expect(accentFills('"text-accent border-accent outline-accent accent-accent"')).toEqual([]);
  expect(accentFills('{ backgroundColor: "var(--accent-strong)" }')).toEqual([]);
  expect(accentFills("  --color-accent: var(--accent);")).toEqual([]);
});

test("accent_fill_guard: no opaque --accent fill in src/ (#107)", () => {
  const files = sources("src");
  // The scan must see the app, not an empty or wrong directory.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain(join("src", "features", "palette", "CommandPalette.tsx"));
  const bad = files.flatMap((f) =>
    accentFills(readFileSync(f, "utf8"))
      .map((m) => `${f}: ${m}`)
      .filter((m) => !(m in ALLOWED)),
  );
  expect(bad).toEqual([]);
});
