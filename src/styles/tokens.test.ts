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
  "--rownum",
  "--bottom",
  "--btn",
  "--accent",
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
