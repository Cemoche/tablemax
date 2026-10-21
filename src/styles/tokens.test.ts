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
  "--focus-ring-inner",
  "--accent-control",
  "--inserted",
  "--modified",
  "--deleted",
  "--deleted-text",
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

test("driver tiles: each engine's monogram reads 4.5:1 on its tile, the same in both themes (#88)", () => {
  const light = values(LIGHT);
  const tiles = ["pg", "my", "ma", "sl", "other"];
  for (const t of tiles) {
    expect(light[`--driver-${t}`], t).toMatch(/^#[0-9A-F]{6}$/i);
    expect(contrastRatio(light[`--driver-${t}-text`], light[`--driver-${t}`]), t).toBeGreaterThanOrEqual(4.5);
  }
  // One colour per engine; brand-like tiles do not change with the theme.
  expect(new Set(tiles.map((t) => light[`--driver-${t}`])).size).toBe(tiles.length);
  for (const selector of [DARK_MEDIA, DARK_FORCED]) {
    for (const t of tiles) expect(values(selector)[`--driver-${t}`], `${selector} ${t}`).toBeUndefined();
  }
});

test("connection colour dots (list, form swatches) stand out from the content (3:1) in both themes (#88)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    const content = v["--content"] ?? values(LIGHT)["--content"];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(contrastRatio(v[`--swatch-${n}-icon`], content), `${selector} swatch-${n}-icon`).toBeGreaterThanOrEqual(3);
    }
  }
});

test("connection list rows: the subtitle reads 4.5:1 at rest, hovered and selected, in both themes (#88)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    const ratio = (fg: string, bg: string) => contrastRatio(v[fg], v[bg]);
    expect(ratio("--text-2", "--content"), `${selector} at rest`).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--text-2", "--row-b"), `${selector} hovered`).toBeGreaterThanOrEqual(4.5);
    // Selected rows show the subtitle in --text (--text-2 is 3.9:1 on the light --sel).
    expect(ratio("--text", "--sel"), `${selector} selected`).toBeGreaterThanOrEqual(4.5);
  }
});

test("sql_editor_contrast: the SQL text colours read 4.5:1 on the editor and on the current-statement band, in both themes (#89)", () => {
  const SQL_TEXT = ["--sql-keyword", "--sql-function", "--sql-number", "--sql-string", "--sql-comment"];
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    for (const t of [...SQL_TEXT, "--sql-current", "--sql-selection"]) {
      expect(values(selector)[t], `${selector} ${t}`).toMatch(/^#[0-9A-F]{6}$/i);
    }
    for (const fg of SQL_TEXT) {
      for (const bg of ["--content", "--sql-current"]) {
        expect(contrastRatio(v[fg], v[bg]), `${selector} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The band stays visible on the editor background, and the text reads on the selection.
    expect(contrastRatio(v["--sql-current"], v["--content"]), `${selector} band on content`).toBeGreaterThanOrEqual(1.1);
    expect(contrastRatio(v["--text"], v["--sql-selection"]), `${selector} text on selection`).toBeGreaterThanOrEqual(4.5);
  }
  // The §5.1 band and selection colours are kept as they are.
  expect(values(LIGHT)["--sql-current"]).toBe("#F3EEDE");
  expect(values(DARK_FORCED)["--sql-current"]).toBe("#30363F");
  expect(values(LIGHT)["--sql-selection"]).toBe("#FFEA84");
  expect(values(DARK_FORCED)["--sql-selection"]).toBe("#003F84");
});

/** `fg` at `alpha` over `bg`, as #RRGGBB (what an `opacity-70` label shows). */
function over(fg: string, bg: string, alpha: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const mix = [0, 1, 2].map((i) => Math.round(alpha * ch(fg, i) + (1 - alpha) * ch(bg, i)));
  return `#${mix.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

test("accent_text_contrast: text on an accent fill (menus, palette, primary buttons, TabList, completions) reads 4.5:1 on --accent-strong (#107)", () => {
  const onAccent = values(LIGHT)["--accent-contrast"];
  // The light text of filled controls is white in both themes (not redefined in dark).
  expect(onAccent).toBe("#FFFFFF");
  for (const selector of [DARK_MEDIA, DARK_FORCED]) expect(values(selector)["--accent-contrast"], selector).toBeUndefined();
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    // Menu rows, the palette's selected item, primary dialog buttons, TabList, completions.
    expect(contrastRatio(onAccent, v["--accent-strong"]), `${selector} accent-contrast on accent-strong`).toBeGreaterThanOrEqual(4.5);
    // Not on the §5.1 accent: the reason for the rule.
    expect(contrastRatio(onAccent, v["--accent"]), `${selector} accent-contrast on accent`).toBeLessThan(4.5);
    // A 70 % hint (shortcut, kind) would not read on the fill: highlighted rows show it opaque.
    expect(contrastRatio(over(onAccent, v["--accent-strong"], 0.7), v["--accent-strong"]), `${selector} 70 % hint`).toBeLessThan(4.5);
  }
});

/** Hue (0–360°) of a #RRGGBB colour. */
function hue(hex: string): number {
  const [r, g, b] = [0, 1, 2].map((i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

test("danger_fill_contrast: a destructive button's label reads 4.5:1 on --danger-strong, not on --danger (#128)", () => {
  const onDanger = values(LIGHT)["--danger-contrast"];
  // White in both themes (not redefined in dark), like --accent-contrast.
  expect(onDanger).toBe("#FFFFFF");
  for (const selector of [DARK_MEDIA, DARK_FORCED]) expect(values(selector)["--danger-contrast"], selector).toBeUndefined();
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = values(selector);
    expect(v["--danger-strong"], `${selector} danger-strong`).toMatch(/^#[0-9A-F]{6}$/i);
    // ConfirmDialog's confirm button (Discard, Delete…).
    expect(contrastRatio(onDanger, v["--danger-strong"]), `${selector} danger-contrast on danger-strong`).toBeGreaterThanOrEqual(4.5);
    // Still the danger red: same hue as --danger.
    expect(Math.abs(hue(v["--danger-strong"]) - hue(v["--danger"])), `${selector} hue`).toBeLessThan(5);
  }
  // The reason for the token: white on the dark --danger is 2.78:1.
  expect(contrastRatio(onDanger, values(DARK_FORCED)["--danger"])).toBeLessThan(4.5);
});

/**
 * The backgrounds under --accent-text, from its uses (#129): Breadcrumb links (--content,
 * hovered --seg-sel), Row detail "→ table" links (--side, hovered --seg-sel), Structure
 * foreign key links (--win), the grid's FK indicator (linkColor: --row-a, --row-b, and --sel
 * in a selected column, Glide's accentLight). Elsewhere the indicator takes the text of what
 * it sits on (gridTheme.ts): on an edited cell the text that reads best on --modified, on a
 * deleted row that row's --deleted-text (#136), on a selected row white.
 */
const ACCENT_TEXT_BACKGROUNDS = ["--content", "--seg-sel", "--side", "--win", "--row-a", "--row-b", "--sel"];

/**
 * The backgrounds under --danger-text, from its uses (#129):
 * - --content (= --surface): dialogs, palette, settings panes, connection form, results and
 *   pending changes panels, cell editor overlay, safe mode alert;
 * - --win (= --bg): table tab notices, disconnected workspace, Structure and Index tabs, the
 *   toolbar's safe mode button;
 * - --side: sidebar (failed object row, history, saved queries), filter bar, row detail;
 * - --filter-applied: a filter row's reading on an applied row;
 * - --pill: filter SQL preview, page popover;
 * - --btn: query Cancel, history Clear, SSL Browse buttons;
 * - --seg-sel (= --surface-2): those buttons, dialog danger buttons, sidebar rows and toolbar
 *   buttons hovered or expanded;
 * - --row-a, --row-b, --sel: a failed row in the grid (a selected column paints --sel).
 *   On a change fill (edited cell, inserted or deleted row) the fill's own text wins.
 */
const DANGER_TEXT_BACKGROUNDS = [
  "--content",
  "--win",
  "--side",
  "--filter-applied",
  "--pill",
  "--btn",
  "--seg-sel",
  "--row-a",
  "--row-b",
  "--sel",
];

test("accent_as_text_contrast: --accent-text reads 4.5:1 on every background it sits on, in both themes (#129)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    expect(values(selector)["--accent-text"], `${selector} accent-text`).toMatch(/^#[0-9A-F]{6}$/i);
    for (const bg of ACCENT_TEXT_BACKGROUNDS) {
      expect(contrastRatio(v["--accent-text"], v[bg]), `${selector} accent-text on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // Still the accent: same hue as --accent.
    expect(Math.abs(hue(v["--accent-text"]) - hue(v["--accent"])), `${selector} hue`).toBeLessThan(5);
  }
  // The reason for the token: the §5.1 accent is 4.02:1 (light) / 4.24:1 (dark) on --content.
  for (const selector of [LIGHT, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    expect(contrastRatio(v["--accent"], v["--content"]), selector).toBeLessThan(4.5);
  }
});

test("danger_as_text_contrast: --danger-text reads 4.5:1 on every background it sits on, in both themes (#129)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    expect(values(selector)["--danger-text"], `${selector} danger-text`).toMatch(/^#[0-9A-F]{6}$/i);
    for (const bg of DANGER_TEXT_BACKGROUNDS) {
      expect(contrastRatio(v["--danger-text"], v[bg]), `${selector} danger-text on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(Math.abs(hue(v["--danger-text"]) - hue(v["--danger"])), `${selector} hue`).toBeLessThan(5);
    // --danger stays for borders and outlines (aria-invalid fields, the dialog danger
    // button's border): 3:1, non-text, on the fields and surfaces they edge.
    for (const bg of ["--content", "--search", "--pill"]) {
      expect(contrastRatio(v["--danger"], v[bg]), `${selector} danger border on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  }
  // The reason for the token (#128): --danger is under 4.5:1 on dark --btn, --pill,
  // --seg-sel and --sel, and on light --seg-sel and --sel.
  const dark = { ...values(LIGHT), ...values(DARK_FORCED) };
  for (const bg of ["--btn", "--pill", "--seg-sel", "--sel"]) {
    expect(contrastRatio(dark["--danger"], dark[bg]), `dark danger on ${bg}`).toBeLessThan(4.5);
  }
  const light = values(LIGHT);
  for (const bg of ["--seg-sel", "--sel"]) {
    expect(contrastRatio(light["--danger"], light[bg]), `light danger on ${bg}`).toBeLessThan(4.5);
  }
});

type Rgb = [number, number, number];

/** Linear RGB (0–1) of a #RRGGBB colour. */
function linear(hex: string): Rgb {
  return [0, 1, 2].map((i) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
}

/** CIE L*a*b* (D65) of a linear RGB colour. */
function labOf([r, g, b]: Rgb): Rgb {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 colour difference ΔE*ab of two linear RGB colours. */
function deltaELinear(a: Rgb, b: Rgb): number {
  const [p, q] = [labOf(a), labOf(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** CIE76 colour difference ΔE*ab of two #RRGGBB colours (about 2.3: just noticeable). */
const deltaE = (a: string, b: string) => deltaELinear(linear(a), linear(b));

/** Machado, Oliveira & Fernandes 2009, severity 1.0, applied in linear RGB. */
const CVD: Record<string, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

/** `hex` as seen with the colour vision deficiency `kind`, in linear RGB. */
function simulate(hex: string, kind: string): Rgb {
  const c = linear(hex);
  return CVD[kind].map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))) as Rgb;
}

/**
 * The text drawn on each change fill (#136): the grid's cell text, NULL / EMPTY / DEFAULT
 * placeholders and FK indicator on an inserted row (--cell-text) or a deleted row
 * (--deleted-text, struck through), the text that reads best on an edited cell (--cell-text
 * or white, gridTheme.ts), and --text in the pending changes panel's badges and the row
 * detail panel's edited field.
 */
const CHANGE_FILL_TEXTS: Record<string, string[]> = {
  "--inserted": ["--cell-text", "--text"],
  // The grid draws white on the dark --modified (the best text, gridTheme.ts); --cell-text reads too.
  "--modified": ["--cell-text", "--text"],
  "--deleted": ["--deleted-text", "--text"],
};

test("change_fill_text_contrast: every text on the inserted, edited and deleted fills reads 4.5:1, in both themes (#136)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    expect(values(selector)["--deleted-text"], `${selector} deleted-text`).toMatch(/^#[0-9A-F]{6}$/i);
    for (const [fill, texts] of Object.entries(CHANGE_FILL_TEXTS)) {
      for (const fg of texts) {
        expect(contrastRatio(v[fg], v[fill]), `${selector} ${fg} on ${fill}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // In a selected column Glide paints --sel (accentLight) under the row's text.
    for (const fg of ["--cell-text", "--deleted-text"]) {
      expect(contrastRatio(v[fg], v["--sel"]), `${selector} ${fg} on --sel`).toBeGreaterThanOrEqual(4.5);
    }
    // A deleted row stays dimmer than the others (with its strike-through), still readable.
    expect(contrastRatio(v["--deleted-text"], v["--deleted"]), `${selector} deleted text dimmer`).toBeLessThan(
      contrastRatio(v["--cell-text"], v["--deleted"]),
    );
  }
});

test("change_fills_distinct: the three change fills stand apart from each other, the rows, --sel and the selected rows (#136)", () => {
  const FILLS = ["--inserted", "--modified", "--deleted"];
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    const row = (t: string) => (t === "--row-selected" ? v["--accent-strong"] : v[t]);
    for (const [i, fill] of FILLS.entries()) {
      for (const other of [...FILLS.slice(i + 1), "--row-a", "--row-b", "--sel", "--row-selected"]) {
        expect(deltaE(v[fill], row(other)), `${selector} ${fill} vs ${other}`).toBeGreaterThanOrEqual(20);
      }
    }
    // Inserted (green) and edited (amber) stay apart for red-green colour blindness too: a
    // luminance gap, not the hue alone (#136 review: dark #43702E fell to ΔE 4.1 protan).
    for (const kind of Object.keys(CVD)) {
      expect(
        deltaELinear(simulate(v["--inserted"], kind), simulate(v["--modified"], kind)),
        `${selector} inserted vs modified, ${kind}`,
      ).toBeGreaterThanOrEqual(10);
    }
  }
});

/**
 * The backgrounds a CSS focus ring sits on or next to (#135), from the focusables: dialogs,
 * popovers, palette, forms and panels (--content), the window and table tab notices (--win),
 * the sidebar, filter bar and row detail (--side), the bottom bars (--bottom), buttons
 * (--btn), pills, menus and popovers (--pill), fields (--search), tab capsules (--tab,
 * --tab-sel), hovered or pressed rows and toolbar buttons (--seg-sel), selected rows and
 * settings sections (--sel), an applied filter row (--filter-applied), a hovered connection
 * group (--row-b), filled controls, the selected segment and highlighted menu rows
 * (--accent-strong), the row detail's edited field (--modified), and the fills next to the
 * status pill's ring: its connection tint (--swatch-N-tint; --pill while not connected) and
 * the tag badge at its start (--tag-*-bg).
 */
const FOCUS_RING_BACKGROUNDS = [
  "--content",
  "--win",
  "--side",
  "--bottom",
  "--btn",
  "--pill",
  "--search",
  "--tab",
  "--tab-sel",
  "--seg-sel",
  "--sel",
  "--filter-applied",
  "--row-b",
  "--accent-strong",
  "--modified",
  ...[1, 2, 3, 4, 5, 6].map((n) => `--swatch-${n}-tint`),
  ...["local", "dev", "staging", "prod"].map((t) => `--tag-${t}-bg`),
];

/**
 * The fills under the grid's focused cell (#135): plain and zebra rows, a selected column
 * (--sel, Glide's accentLight), a selected row (--row-selected = --accent-strong) and the
 * three change fills.
 */
const GRID_FOCUS_BACKGROUNDS = ["--row-a", "--row-b", "--sel", "--accent-strong", "--inserted", "--modified", "--deleted"];

test("focus_ring_contrast: the two-tone ring reaches 3:1 on every background, its bands 3:1 apart, in both themes (#135)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    const inner = v["--focus-ring-inner"];
    expect(values(selector)["--focus-ring-inner"], `${selector} focus-ring-inner`).toMatch(/^#[0-9A-F]{6}$/i);
    // The two bands stand apart: the ring reads as two tones, never as one blurred line.
    expect(contrastRatio(v["--accent"], inner), `${selector} accent vs inner`).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(v["--cell-focus"], inner), `${selector} cell-focus vs inner`).toBeGreaterThanOrEqual(3);
    // The inner band alone reaches 3:1 wherever the ring is drawn (the accent band too where it can).
    for (const bg of FOCUS_RING_BACKGROUNDS) {
      expect(contrastRatio(inner, v[bg]), `${selector} inner on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    for (const bg of GRID_FOCUS_BACKGROUNDS) {
      expect(contrastRatio(inner, v[bg]), `${selector} grid inner on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  }
  // The reason for the second band: the accent alone is under 3:1 on --sel (light 2.71, dark
  // 2.40) and on the dark active tab (1.70); the red of the focused cell on the change fills.
  const light = values(LIGHT);
  const dark = { ...light, ...values(DARK_FORCED) };
  expect(contrastRatio(light["--accent"], light["--sel"])).toBeLessThan(3);
  expect(contrastRatio(dark["--accent"], dark["--sel"])).toBeLessThan(3);
  expect(contrastRatio(dark["--accent"], dark["--tab-sel"])).toBeLessThan(3);
  expect(contrastRatio(light["--cell-focus"], light["--deleted"])).toBeLessThan(3);
  expect(contrastRatio(dark["--cell-focus"], dark["--modified"])).toBeLessThan(3);
});

/**
 * The backgrounds under a native checkbox or radio (#135): the Columns popover (--pill, its
 * hovered row --seg-sel), the filter bar (--side, an applied row --filter-applied) and the
 * connection form's SSH box (--content).
 */
const CHECKBOX_BACKGROUNDS = ["--pill", "--seg-sel", "--side", "--filter-applied", "--content"];

test("checkbox_contrast: a checked box (accent-color --accent-control) reads 3:1 on its backgrounds, its white mark 3:1 on it (#135)", () => {
  for (const selector of [LIGHT, DARK_MEDIA, DARK_FORCED]) {
    const v = { ...values(LIGHT), ...values(selector) };
    expect(values(selector)["--accent-control"], `${selector} accent-control`).toMatch(/^#[0-9A-F]{6}$/i);
    for (const bg of CHECKBOX_BACKGROUNDS) {
      expect(contrastRatio(v["--accent-control"], v[bg]), `${selector} accent-control on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio("#FFFFFF", v["--accent-control"]), `${selector} check mark`).toBeGreaterThanOrEqual(3);
    // Still the accent: same hue.
    expect(Math.abs(hue(v["--accent-control"]) - hue(v["--accent"])), `${selector} hue`).toBeLessThan(5);
  }
  // The reason for the token: the accent is 2.98:1 on the dark --pill and 2.93:1 on the light --seg-sel.
  const light = values(LIGHT);
  const dark = { ...light, ...values(DARK_FORCED) };
  expect(contrastRatio(dark["--accent"], dark["--pill"])).toBeLessThan(3);
  expect(contrastRatio(light["--accent"], light["--seg-sel"])).toBeLessThan(3);
});
