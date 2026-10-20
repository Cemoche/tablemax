/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { contrastRatio } from "../lib/contrast";

// Read from disk (path from the repo root, where vitest runs): vitest replaces CSS
// imports, even `?raw`, with an empty module.
const css = readFileSync("src/styles/tokens.css", "utf8");

const LIGHT = ":root";
const DARK_MEDIA = ':root:not([data-theme="light"])';
const DARK_FORCED = ':root[data-theme="dark"]';

/** Body of the first block opened by `selector`. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

/** Custom properties declared in the first block opened by `selector`, with their values. */
function values(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block(selector).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const declared = (selector: string) => Object.keys(values(selector)).sort();

/** The tokens of the spec §5.1 (docs/superpowers/specs/2026-10-19-tablemax-ui-redesign-design.md). */
const THEME_TOKENS = [
  "--win",
  "--side",
  "--content",
  "--sep",
  "--pill",
  "--pill-border",
  "--icon",
  "--icon-dim",
  "--text",
  "--text-2",
  "--seg-sel",
  "--search",
  "--sel",
  "--tab",
  "--tab-sel",
  "--grid-head",
  "--head-text",
  "--row-a",
  "--row-b",
  "--grid-sep",
  "--cell-text",
  "--placeholder",
  "--bottom",
  "--btn",
  "--accent",
  "--accent-strong",
  "--cell-focus",
  "--inserted",
  "--modified",
  "--deleted",
  ...["local", "dev", "staging", "prod"].flatMap((t) => [`--tag-${t}-bg`, `--tag-${t}-text`]),
  ...[1, 2, 3, 4, 5, 6].map((n) => `--swatch-${n}`),
];

// Dark values are written twice (OS dark media block and forced data-theme="dark"): a
// token missing from one of them keeps its light value in that mode.
test("both dark blocks override the same tokens with the same values", () => {
  expect(values(DARK_FORCED)).toEqual(values(DARK_MEDIA));
});

test("every dark token has a light default", () => {
  const light = declared(LIGHT);
  for (const t of declared(DARK_FORCED)) expect(light, t).toContain(t);
});

test("every_token_defined_in_both_themes", () => {
  const light = values(LIGHT);
  const dark = values(DARK_FORCED);
  for (const t of THEME_TOKENS) {
    expect(light[t], `light ${t}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(dark[t], `dark ${t}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
  }
});

test("light_theme_contrast", () => {
  for (const [name, selector] of [
    ["light", LIGHT],
    ["dark", DARK_FORCED],
  ] as const) {
    const v = values(selector);
    const ratio = (fg: string, bg: string) => contrastRatio(v[fg], v[bg]);
    expect(ratio("--text", "--content"), `${name} text`).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--text-2", "--side"), `${name} text-2`).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--placeholder", "--row-a"), `${name} placeholder / row-a`).toBeGreaterThanOrEqual(3);
    expect(ratio("--placeholder", "--row-b"), `${name} placeholder / row-b`).toBeGreaterThanOrEqual(3);
  }
});

test("selection_contrast: white reads 4.5:1 on selected rows and filled controls (--accent-strong), not on the accent (#103)", () => {
  const white = values(LIGHT)["--row-selected-text"];
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    expect(contrastRatio(white, v["--accent-strong"]), `${selector} white on accent-strong`).toBeGreaterThanOrEqual(4.5);
    // The §5.1 accent alone gives 4.0:1 (light) / 3.9:1 (dark): white text never sits on it.
    expect(contrastRatio(white, v["--accent"]), `${selector} white on accent`).toBeLessThan(4.5);
  }
  // Selected rows (grid) use the deeper fill; the §5.1 accent itself is unchanged.
  expect(values(LIGHT)["--row-selected"]).toBe("var(--accent-strong)");
  expect(values(LIGHT)["--accent"]).toBe("#007AFF");
  expect(values(DARK_FORCED)["--accent"]).toBe("#3A7BF6");
});

test("row_number_column: the header's colours on every row, readable in both themes; #102's row number tokens are gone (#103)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    expect(contrastRatio(v["--head-text"], v["--grid-head"]), `${selector} head-text on grid-head`).toBeGreaterThanOrEqual(4.5);
    expect(v["--rownum"], selector).toBeUndefined();
    expect(v["--rownum-selected"], selector).toBeUndefined();
  }
});

test("the previous token names stay as aliases of the new ones", () => {
  const light = values(LIGHT);
  for (const old of ["--bg", "--surface", "--surface-2", "--text-muted", "--border", "--accent-contrast"])
    expect(light[old], old).toBeTruthy();
  expect(light["--surface"]).toBe("var(--content)");
  expect(light["--text-muted"]).toBe("var(--text-2)");
  expect(light["--pending-edit"]).toBe("var(--modified)");
  expect(light["--pending-insert"]).toBe("var(--inserted)");
  expect(light["--pending-delete"]).toBe("var(--deleted)");
});

test("fonts: system UI font, bundled JetBrains Mono for data, 13 px base", () => {
  const light = values(LIGHT);
  expect(light["--font-ui"]).toBe("system-ui, sans-serif");
  expect(light["--font-mono"]).toBe('"JetBrains Mono", ui-monospace, monospace');
  expect(light["--text-md"]).toBe("13px");
});

test("the status pill text is readable on every connection tint and in every state (#104)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    const ratio = (fg: string, bg: string) => contrastRatio(v[fg], v[bg]);
    // ~12 px text: WCAG AA for small text, 4.5:1.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(v[`--swatch-${n}-tint`], `${selector} swatch-${n}-tint`).toMatch(/^#[0-9A-F]{6}$/i);
      expect(ratio(`--swatch-${n}-tint-text`, `--swatch-${n}-tint`), `${selector} swatch-${n}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const state of ["--status-connecting", "--status-error", "--text-2"]) {
      expect(ratio(state, "--pill"), `${selector} ${state}`).toBeGreaterThanOrEqual(4.5);
    }
    // The tag badge at the start of the pill.
    for (const tag of ["local", "dev", "staging", "prod"]) {
      expect(ratio(`--tag-${tag}-text`, `--tag-${tag}-bg`), `${selector} tag ${tag}`).toBeGreaterThanOrEqual(4.5);
    }
    // The old text-on-swatch tokens are gone (the pill sits on the tint now).
    expect(v["--swatch-1-text"], selector).toBeUndefined();
  }
  // Light: the light swatch itself (a light tint) under dark text. Dark: a darker tint than
  // the saturated swatch, under light text.
  const light = values(LIGHT);
  const dark = values(DARK_FORCED);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    expect(light[`--swatch-${n}-tint`]).toBe(light[`--swatch-${n}`]);
    expect(contrastRatio(dark[`--swatch-${n}-tint`], "#000000"), `dark tint ${n} darker than the swatch`).toBeLessThan(
      contrastRatio(dark[`--swatch-${n}`], "#000000"),
    );
  }
});

test("connection tile icons and object icons stand out (3:1, non-text) in both themes (#104)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    const ratio = (fg: string, bg: string) => contrastRatio(v[fg], v[bg]);
    // The outlined database icon in the connection color on the neutral tile (--pill).
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(ratio(`--swatch-${n}-icon`, "--pill"), `${selector} swatch-${n}-icon`).toBeGreaterThanOrEqual(3);
    }
    // Tables blue, views purple, on the sidebar, a hovered row and a selected row.
    for (const icon of ["--icon-table", "--icon-view"]) {
      for (const bg of ["--side", "--seg-sel", "--sel"]) {
        expect(ratio(icon, bg), `${selector} ${icon} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  }
});

test("the Windows close button turns red with a white glyph (#104)", () => {
  const v = values(LIGHT);
  expect(contrastRatio(v["--window-close-text"], v["--window-close"])).toBeGreaterThanOrEqual(4.5);
});

test("tab text is readable on the capsules in both themes (ruling R3: surfaces unchanged)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    const ratio = (fg: string, bg: string) => contrastRatio(v[fg], v[bg]);
    // Inactive capsules: --tab-text on --tab. The active capsule (--tab-sel) shows --text,
    // and its database badge inherits it.
    expect(ratio("--tab-text", "--tab"), `${selector} tab-text on tab`).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--text", "--tab-sel"), `${selector} text on tab-sel`).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--text", "--tab"), `${selector} text on tab (hover)`).toBeGreaterThanOrEqual(4.5);
  }
  // The light §5.1 surfaces stay as they were.
  expect(values(LIGHT)["--tab"]).toBe("#DCDCDC");
  expect(values(LIGHT)["--tab-sel"]).toBe("#FFFFFF");
});

test("an applied filter row's tint keeps its text readable in both themes (ruling R3: the text, not the surface)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    // The tint is the accent at 15 % over the bar (--side), written out as a color.
    expect(v["--filter-applied"], selector).toMatch(/^#[0-9A-F]{6}$/i);
    // The row's own text (the "and" between two values) is --text, readable on the tint.
    expect(contrastRatio(v["--text"], v["--filter-applied"]), `${selector} text on tint`).toBeGreaterThanOrEqual(4.5);
  }
  // --text-2 would not be (light: 4.06:1): the row must not use it.
  expect(contrastRatio(values(LIGHT)["--text-2"], values(LIGHT)["--filter-applied"])).toBeLessThan(4.5);
});
