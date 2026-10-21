import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Focus rings (#135): one two-tone ring for the whole app, the `focus-ring` (outside the
// control) and `focus-ring-inset` (inside it, for rows, tabs and controls whose parent clips)
// utilities of src/index.css: a 2 px --accent outline plus a --focus-ring-inner band, 3:1 on
// every background (tokens.test.ts, focus_ring_contrast). A single-tone ring (an outline, ring
// or border colour under a focus variant) is refused, and so is an `outline-none` that drops
// the browser's ring without drawing ours, unless ALLOWED says why.
// Read as text, like accentText.test.ts: class strings in the sources.

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** The class tokens of each string literal of a source text. */
function classStrings(text: string): { literal: string; tokens: string[] }[] {
  return (text.match(LITERAL) ?? []).map((literal) => ({ literal, tokens: literal.slice(1, -1).split(/[\s"'`{}$]+/) }));
}

/** The variants of a class token (`peer-focus-visible:`, `has-[:focus-visible]:`…) and its utility. */
function split(token: string): { variants: string; utility: string } {
  // A `:` inside brackets belongs to an arbitrary variant, not to the separator.
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ":" && depth === 0) last = i;
  }
  return { variants: token.slice(0, last + 1), utility: token.slice(last + 1).replace(/^!|!$/g, "") };
}

const FOCUS_VARIANT = /focus/;
/** A one-colour indicator: an outline or ring utility, or a border colour (`focus:border-accent`). */
const SINGLE_TONE = /^-?(?:outline|ring)(?:-|$)|^border-(?:accent|danger|text|fg)/;
/** The shared ring, under any focus variant. */
const SHARED_RING = /^(?:\S*focus\S*:)focus-ring(?:-inset)?$/;

/** Single-tone focus indicators of a source text. */
function singleToneRings(text: string): string[] {
  const out: string[] = [];
  for (const { literal, tokens } of classStrings(text)) {
    for (const t of tokens) {
      const { variants, utility } = split(t);
      if (FOCUS_VARIANT.test(variants) && SINGLE_TONE.test(utility)) out.push(`${t} in ${literal.slice(0, 80)}…`);
    }
  }
  return out;
}

/** Class strings that drop the browser's ring (`outline-none`) without drawing the shared one. */
function ringless(text: string): string[] {
  return classStrings(text)
    .filter(({ tokens }) => tokens.includes("outline-none") && !tokens.some((t) => SHARED_RING.test(t)))
    .map(({ literal }) => literal);
}

/**
 * `outline-none` without the shared ring, by file and a piece of its class string → reason.
 * Each one shows its focus another way, or never takes keyboard focus visibly.
 */
const ALLOWED: { file: string; has: string; reason: string }[] = [
  {
    file: "src/features/grid/RowDetailPanel.tsx",
    has: "min-w-0 flex-1 bg-transparent",
    reason: "the search input: its field draws the ring (focus-within)",
  },
  {
    file: "src/features/sidebar/SidebarSearch.tsx",
    has: "min-w-0 flex-1 bg-transparent",
    reason: "the search input: its field draws the ring (focus-within)",
  },
  {
    file: "src/features/palette/CommandPalette.tsx",
    has: "border-b border-border bg-surface px-3 py-2",
    reason: "the palette's only input, focused on open; the caret shows the focus",
  },
  {
    file: "src/features/grid/CellEditorOverlay.tsx",
    has: "resize border-0 bg-surface",
    reason: "the cell editor, focused on open over the grid's focused cell; the caret shows the focus",
  },
  {
    file: "src/features/workspace/WorkspaceView.tsx",
    has: "min-h-0 flex-1 overflow-auto",
    reason: "a scroll region focused by code to keep the shortcuts' scope, not a control",
  },
  {
    file: "src/features/grid/PagePopover.tsx",
    has: "absolute bottom-full z-30",
    reason: "the box of the Page and Columns popovers (a dialog, not focusable itself); its controls draw the ring",
  },
  {
    file: "src/features/grid/FilterSqlPreview.tsx",
    has: "absolute top-full left-0 z-40",
    reason: "a popover container focused by code (tabIndex -1); its controls draw the ring",
  },
  {
    file: "src/features/chrome/ConnectionPopover.tsx",
    has: "absolute top-full z-50 mt-1.5 w-80",
    reason: "a popover container focused by code (tabIndex -1); its controls draw the ring",
  },
];

const allowed = (file: string, literal: string) => ALLOWED.some((a) => a.file === file && literal.includes(a.has));

test("split separates variants from the utility, brackets included", () => {
  expect(split("focus-visible:-outline-offset-2")).toEqual({ variants: "focus-visible:", utility: "-outline-offset-2" });
  expect(split("has-[:focus-visible]:focus-ring")).toEqual({ variants: "has-[:focus-visible]:", utility: "focus-ring" });
  expect(split("outline-none")).toEqual({ variants: "", utility: "outline-none" });
  expect(split("focus-visible:outline-accent!")).toEqual({ variants: "focus-visible:", utility: "outline-accent" });
});

test("singleToneRings finds every one-colour focus indicator, not the shared ring", () => {
  expect(singleToneRings('"outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"')).toHaveLength(3);
  expect(singleToneRings('"focus-visible:-outline-offset-2"')).toHaveLength(1);
  expect(singleToneRings('"focus-within:outline-2"')).toHaveLength(1);
  expect(singleToneRings('"peer-focus-visible:outline-accent"')).toHaveLength(1);
  expect(singleToneRings('"aria-selected:focus-visible:outline-accent-contrast"')).toHaveLength(1);
  expect(singleToneRings('"focus:border-accent"')).toHaveLength(1);
  expect(singleToneRings('"focus-visible:ring-2 focus-visible:ring-accent"')).toHaveLength(2);
  expect(singleToneRings('"outline-none focus-visible:focus-ring"')).toEqual([]);
  expect(singleToneRings('"focus-within:focus-ring-inset has-[:focus-visible]:focus-ring"')).toEqual([]);
  // Not a focus state: an invalid field's outline colour, a checked swatch's ring.
  expect(singleToneRings('"aria-invalid:outline-danger peer-checked:ring-2"')).toEqual([]);
});

test("ringless finds an outline-none without the shared ring", () => {
  expect(ringless('"px-2 outline-none hover:bg-seg-sel"')).toHaveLength(1);
  expect(ringless('"px-2 outline-none focus-visible:bg-accent-strong"')).toHaveLength(1);
  expect(ringless('"outline-none focus-visible:focus-ring"')).toEqual([]);
  expect(ringless('"outline-none focus-visible:focus-ring-inset"')).toEqual([]);
  expect(ringless('`${base} outline-none focus-within:focus-ring-inset`')).toEqual([]);
  // A ring utility without a focus variant would show on every element, focused or not.
  expect(ringless('"outline-none focus-ring"')).toHaveLength(1);
  expect(ringless('"px-2 hover:bg-seg-sel"')).toEqual([]);
});

function appSources(): string[] {
  const files = sources("src");
  // The scan must see the app, not an empty or wrong directory.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain(join("src", "features", "palette", "CommandPalette.tsx"));
  return files;
}

test("focus_ring_two_tone: no focus indicator is a single-tone outline, ring or border (#135)", () => {
  const bad = appSources().flatMap((f) => singleToneRings(readFileSync(f, "utf8")).map((m) => `${f}: ${m}`));
  expect(bad).toEqual([]);
});

test("focus_ring_shared: every outline-none draws the shared ring under a focus variant, or ALLOWED says why (#135)", () => {
  const files = appSources();
  const bad = files.flatMap((f) =>
    ringless(readFileSync(f, "utf8"))
      .filter((literal) => !allowed(f, literal))
      .map((literal) => `${f}: ${literal.slice(0, 100)}`),
  );
  expect(bad).toEqual([]);
  // Every exception still matches a class string (no stale entry).
  for (const a of ALLOWED) {
    expect(ringless(readFileSync(a.file, "utf8")).some((l) => l.includes(a.has)), `${a.file}: ${a.has}`).toBe(true);
  }
});

test("focus_ring_utilities: the shared ring is a 2 px accent outline plus the inner band, outside or inset (#135)", () => {
  const css = readFileSync("src/index.css", "utf8");
  const body = (name: string) => {
    const start = css.indexOf(`@utility ${name} {`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };
  const outside = body("focus-ring");
  expect(outside).toMatch(/outline:\s*2px solid var\(--accent\);/);
  expect(outside).toMatch(/outline-offset:\s*1px;/);
  expect(outside).toMatch(/box-shadow:\s*0 0 0 1px var\(--focus-ring-inner\)/);
  const inset = body("focus-ring-inset");
  expect(inset).toMatch(/outline:\s*2px solid var\(--accent\);/);
  expect(inset).toMatch(/outline-offset:\s*-2px;/);
  expect(inset).toMatch(/box-shadow:\s*inset 0 0 0 3px var\(--focus-ring-inner\)/);
  // A control's own shadow (Tailwind's shadow and ring layers) stays under the band.
  for (const b of [outside, inset]) {
    for (const layer of ["--tw-inset-shadow", "--tw-inset-ring-shadow", "--tw-ring-offset-shadow", "--tw-ring-shadow", "--tw-shadow"]) {
      expect(b, layer).toContain(`var(${layer}, 0 0 #0000)`);
    }
  }
});

test("checkbox_accent: native checkboxes and radios take --accent-control, never --accent (#135)", () => {
  const bad = appSources().flatMap((f) =>
    classStrings(readFileSync(f, "utf8")).flatMap(({ tokens }) =>
      tokens.filter((t) => split(t).utility === "accent-accent").map((t) => `${f}: ${t}`),
    ),
  );
  expect(bad).toEqual([]);
});
