import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// White text reads 4.0:1 (light) / 3.9:1 (dark) on --accent, under the 4.5:1 of WCAG AA:
// a filled control or highlighted row uses --accent-strong (#103, #107). Same for --danger
// (white 2.78:1 in dark): a destructive button with a label uses --danger-strong (#128).
// An opaque --accent or --danger fill is refused whatever the text colour (the text may come
// from another string, a `cn()` argument or an inherited colour); both tokens stay for tints
// (`bg-accent/30`), focus rings, borders and outlines (text uses --accent-text /
// --danger-text: textColor.test.ts, #129). A future fill without text goes to ALLOWED with
// its reason.
// Read as text, like focusRing.test.ts: class strings, inline styles and CSS in the sources.

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** The colours whose opaque fill never sits under text: the "-strong" token does. */
type FillToken = "accent" | "danger";

/**
 * An opaque `token` fill behind any variants (`hover:`, `data-[…]:`), with or without the
 * important modifier: `bg-accent`, `!bg-accent`, `bg-accent!`, `bg-[var(--accent)]`,
 * `bg-(--color-accent)`… A tint (`bg-accent/30`) and `bg-accent-strong` do not match.
 */
const fillClass = (token: FillToken) =>
  new RegExp(`^(?:\\S+:)?!?bg-(?:${token}|\\[var\\(--(?:color-)?${token}\\)\\]|\\(--(?:color-)?${token}\\))!?$`);
/** An inline style or CSS rule painting `token` (not its -strong variant) as a background. */
const fillStyle = (token: FillToken) =>
  new RegExp(`background(?:-color|Color)?\\s*:\\s*["'\`]?var\\(--(?:color-)?${token}\\)`);

/** Exceptions, "file: token" → reason (a fill that never carries text). None today. */
const ALLOWED: Record<string, string> = {};

/** The opaque `token` fills of a source text. */
function fills(text: string, token: FillToken): string[] {
  const cls = fillClass(token);
  const style = fillStyle(token);
  const out: string[] = [];
  for (const literal of text.match(LITERAL) ?? []) {
    for (const t of literal.slice(1, -1).split(/[\s"'`{}$,]+/)) if (cls.test(t)) out.push(t);
  }
  for (const line of text.split("\n")) if (style.test(line)) out.push(line.trim());
  return out;
}

const accentFills = (text: string) => fills(text, "accent");
const dangerFills = (text: string) => fills(text, "danger");

/** Every source file's opaque `token` fills not in ALLOWED, after checking the scan sees the app. */
function badFills(token: FillToken): string[] {
  const files = sources("src");
  // The scan must see the app, not an empty or wrong directory.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain(join("src", "features", "palette", "CommandPalette.tsx"));
  expect(files).toContain(join("src", "features", "workspace", "ConfirmDialog.tsx"));
  return files.flatMap((f) =>
    fills(readFileSync(f, "utf8"), token)
      .map((m) => `${f}: ${m}`)
      .filter((m) => !(m in ALLOWED)),
  );
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

test("dangerFills finds every opaque --danger fill, not tints, borders, text nor --danger-strong", () => {
  expect(dangerFills('"rounded-sm bg-danger px-3 py-1 text-danger-contrast"')).toEqual(["bg-danger"]);
  expect(dangerFills('"hover:bg-danger active:!bg-danger bg-danger!"')).toHaveLength(3);
  expect(dangerFills('"bg-[var(--danger)]" "bg-(--color-danger)"')).toHaveLength(2);
  expect(dangerFills('{ backgroundColor: "var(--danger)" }')).toHaveLength(1);
  expect(dangerFills(".x { background: var(--color-danger); }")).toHaveLength(1);
  expect(dangerFills('"bg-danger-strong text-danger-contrast hover:bg-danger/10"')).toEqual([]);
  expect(dangerFills('"text-danger border-danger aria-invalid:outline-danger"')).toEqual([]);
  expect(dangerFills('{ backgroundColor: "var(--danger-strong)" }')).toEqual([]);
  expect(dangerFills("  --color-danger: var(--danger);")).toEqual([]);
  // Each guard looks for its own token only.
  expect(accentFills('"bg-danger"')).toEqual([]);
  expect(dangerFills('"bg-accent"')).toEqual([]);
});

test("accent_fill_guard: no opaque --accent fill in src/ (#107)", () => {
  expect(badFills("accent")).toEqual([]);
});

test("danger_fill_guard: no opaque --danger fill in src/ (#128)", () => {
  expect(badFills("danger")).toEqual([]);
});
