import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// White text reads 4.0:1 (light) / 3.9:1 (dark) on --accent, under the 4.5:1 of WCAG AA:
// text on an accent fill sits on --accent-strong (#103, #107). --accent stays for fills
// without text (a hovered resize edge), focus rings, icons, borders and tints.
// Read as text, like focusRing.test.ts: class strings and inline styles in the sources.

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/** `bg-accent`, `bg-accent/30`, `bg-[var(--accent)]`, `bg-(--accent)`, behind any variants (`hover:`, `data-[…]:`). */
const ACCENT_BG = /^(?:[^\s]+:)?bg-(?:accent(?:\/\d+)?|\[var\(--accent\)\]|\(--accent\))$/;
/** The light text drawn on filled controls (white in both themes). */
const LIGHT_TEXT = /^(?:[^\s]+:)?text-(?:white|accent-contrast|row-selected-text|on-accent)$/;
/** An inline style or CSS rule painting --accent (not --accent-strong) as a background. */
const ACCENT_BG_STYLE = /background(?:-color|Color)?\s*:\s*["'`]?var\(--accent\)/;

/**
 * Exceptions, with their reason: "file: token" → why. Empty: every accent fill under text
 * moved to --accent-strong (#107).
 */
const ALLOWED: Record<string, string> = {};

/** The class strings that put light text on an --accent fill. */
function lightTextOnAccent(text: string): string[] {
  const out: string[] = [];
  for (const literal of text.match(LITERAL) ?? []) {
    const tokens = literal.slice(1, -1).split(/[\s"'`{}$]+/);
    const fill = tokens.find((t) => ACCENT_BG.test(t));
    const light = tokens.find((t) => LIGHT_TEXT.test(t));
    if (fill && light) out.push(`${fill} + ${light}`);
  }
  for (const line of text.split("\n")) if (ACCENT_BG_STYLE.test(line)) out.push(line.trim());
  return out;
}

test("lightTextOnAccent finds white text on an --accent fill, not on --accent-strong", () => {
  expect(lightTextOnAccent('"rounded-sm bg-accent px-3 py-1 text-accent-contrast"')).toHaveLength(1);
  expect(lightTextOnAccent('"hover:bg-accent hover:text-accent-contrast"')).toHaveLength(1);
  expect(lightTextOnAccent('"data-[selected=true]:bg-accent data-[selected=true]:text-white"')).toHaveLength(1);
  expect(lightTextOnAccent('"bg-[var(--accent)] text-white"')).toHaveLength(1);
  expect(lightTextOnAccent('{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }')).toHaveLength(1);
  expect(lightTextOnAccent(".x { background: var(--accent); }")).toHaveLength(1);
  // The deeper fill, a fill without text, accent text or borders: fine.
  expect(lightTextOnAccent('"hover:bg-accent-strong hover:text-accent-contrast"')).toEqual([]);
  expect(lightTextOnAccent('"hover:bg-accent/30 focus-visible:bg-accent/50"')).toEqual([]);
  expect(lightTextOnAccent('"text-accent border-accent outline-accent"')).toEqual([]);
  expect(lightTextOnAccent('{ backgroundColor: "var(--accent-strong)" }')).toEqual([]);
});

test("accent_text_contrast: no light text on an --accent fill in src/ (#107)", () => {
  const bad = sources("src").flatMap((f) =>
    lightTextOnAccent(readFileSync(f, "utf8"))
      .filter((m) => !Object.keys(ALLOWED).some((k) => k === `${f}: ${m}`))
      .map((m) => `${f}: ${m}`),
  );
  expect(bad).toEqual([]);
});
