import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

// --accent reads 4.02:1 (light) / 4.24:1 (dark) as text, and --danger falls under 4.5:1 on
// dark --btn, --pill, --seg-sel and --sel (#129, #128): text in those colours uses
// --accent-text / --danger-text (`text-accent-text`, `text-danger-text`), tuned to 4.5:1 on
// every background they sit on (tokens.test.ts). --accent and --danger stay for tints,
// focus rings, borders and outlines. An icon coloured through `text-*` uses the text token
// too (4.5:1 covers the 3:1 of non-text). A future exception goes to ALLOWED with its reason.
// Read as text, like accentText.test.ts: class strings, inline styles and CSS in the sources.

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

type TextToken = "accent" | "danger";

/**
 * `token` as a text colour behind any variants (`hover:`, `aria-[…]:`, `placeholder:`), with
 * or without the important modifier or an opacity: `text-accent`, `!text-danger`,
 * `text-accent!`, `text-accent/80`, `text-[var(--accent)]`, `text-(--color-danger)`,
 * `text-[color:var(--accent)]`… `text-accent-text`, `text-accent-contrast` and
 * `text-danger-strong` do not match.
 */
const textClass = (token: TextToken) =>
  new RegExp(
    `^(?:\\S+:)?!?text-(?:${token}|\\[(?:color:)?var\\(--(?:color-)?${token}\\)\\]|\\((?:color:)?--(?:color-)?${token}\\))(?:/\\S+)?!?$`,
  );
/**
 * An inline style or CSS rule painting `token` as the text colour (not `background-color`,
 * `caret-color`…, nor the `text-[color:…]` class form, matched as a class).
 */
const textStyle = (token: TextToken) =>
  new RegExp(`(?<![\\w\\[-])color\\s*:\\s*["'\`]?var\\(--(?:color-)?${token}\\)`);

/** Exceptions, "file: match" → reason. None today. */
const ALLOWED: Record<string, string> = {};

/** The `token` text colours of a source text. */
function texts(text: string, token: TextToken): string[] {
  const cls = textClass(token);
  const style = textStyle(token);
  const out: string[] = [];
  for (const literal of text.match(LITERAL) ?? []) {
    for (const t of literal.slice(1, -1).split(/[\s"'`{}$,]+/)) if (cls.test(t)) out.push(t);
  }
  for (const line of text.split("\n")) if (style.test(line)) out.push(line.trim());
  return out;
}

const accentTexts = (text: string) => texts(text, "accent");
const dangerTexts = (text: string) => texts(text, "danger");

/** Every source file's `token` text colours not in ALLOWED, after checking the scan sees the app. */
function badTexts(token: TextToken): string[] {
  const files = sources("src");
  // The scan must see the app, not an empty or wrong directory.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain(join("src", "features", "grid", "Breadcrumb.tsx"));
  expect(files).toContain(join("src", "features", "editor", "Dialogs.tsx"));
  return files.flatMap((f) =>
    texts(readFileSync(f, "utf8"), token)
      .map((m) => `${f}: ${m}`)
      .filter((m) => !(m in ALLOWED)),
  );
}

test("accentTexts finds --accent used as a text colour, not the text token, fills, rings nor borders", () => {
  expect(accentTexts('"truncate rounded-sm px-1 text-accent hover:bg-surface-2"')).toEqual(["text-accent"]);
  expect(accentTexts('"hover:text-accent aria-[current=page]:text-accent"')).toHaveLength(2);
  expect(accentTexts('"!text-accent text-accent! text-accent/80 placeholder:text-accent"')).toHaveLength(4);
  expect(accentTexts('"text-[var(--accent)] text-[var(--color-accent)] text-(--color-accent) text-[color:var(--accent)]"')).toHaveLength(4);
  expect(accentTexts('cn("underline", "text-accent")')).toHaveLength(1);
  expect(accentTexts('{ color: "var(--accent)" }')).toHaveLength(1);
  expect(accentTexts(".link { color: var(--color-accent); }")).toHaveLength(1);
  // The text token, the fills and their contrast text, tints, borders, rings, native controls.
  expect(accentTexts('"text-accent-text hover:text-accent-text"')).toEqual([]);
  expect(accentTexts('"bg-accent-strong text-accent-contrast bg-accent/30"')).toEqual([]);
  expect(accentTexts('"border-accent outline-accent focus-visible:outline-accent accent-accent"')).toEqual([]);
  expect(accentTexts('{ color: "var(--accent-text)", backgroundColor: "var(--accent)" }')).toEqual([]);
  expect(accentTexts(".x { background-color: var(--accent); caret-color: var(--accent); accent-color: var(--accent); }")).toEqual([]);
  expect(accentTexts("  --color-accent: var(--accent);")).toEqual([]);
});

test("dangerTexts finds --danger used as a text colour, not the text token, fills, borders nor outlines", () => {
  expect(dangerTexts('"px-2 py-1 text-danger"')).toEqual(["text-danger"]);
  expect(dangerTexts('`${btn} ${error ? "text-danger" : ""}`')).toEqual(["text-danger"]);
  expect(dangerTexts('"hover:text-danger !text-danger text-danger/90 text-(--danger)"')).toHaveLength(4);
  expect(dangerTexts('{ color: "var(--danger)" }')).toHaveLength(1);
  expect(dangerTexts(".err { color: var(--danger); }")).toHaveLength(1);
  expect(dangerTexts('"text-danger-text border-danger aria-invalid:border-danger aria-invalid:outline-danger"')).toEqual([]);
  expect(dangerTexts('"bg-danger-strong text-danger-contrast"')).toEqual([]);
  expect(dangerTexts("  --color-danger: var(--danger);")).toEqual([]);
  // Each guard looks for its own token only.
  expect(accentTexts('"text-danger"')).toEqual([]);
  expect(dangerTexts('"text-accent"')).toEqual([]);
});

test("accent_text_guard: no --accent text colour in src/, text uses --accent-text (#129)", () => {
  expect(badTexts("accent")).toEqual([]);
});

test("danger_text_guard: no --danger text colour in src/, text uses --danger-text (#129)", () => {
  expect(badTexts("danger")).toEqual([]);
});

// Tailwind 4 orders utilities of one property by name: in `${btn} text-danger-text` with a
// `btn` holding `text-text`, `.text-text` comes later in the CSS and wins, so the red never
// shows (#129). One class string holds at most one base (unvariant) text colour. The scan
// resolves `${name}` to a string constant of the file or one it imports, and checks each
// branch of a `${cond ? "a" : "b"}` on its own.

/** The colour names of src/index.css (`--color-text` → `text`), so `text-sm` is not one. */
const COLOURS = new Set(
  [...readFileSync("src/index.css", "utf8").matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);

/** The base text colour utilities of a class string (no variant: `hover:text-text` is not one). */
const baseTextColours = (classes: string) =>
  classes.split(/[\s"'`{}$,()]+/).filter((t) => t.startsWith("text-") && COLOURS.has(t.slice(5)));

/** String constants of a source text (`const x = "…"` or a template), by name. */
function constants(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(?:^|\n)(?:export )?const (\w+)\s*=\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g))
    out[m[1]] = m[2].slice(1, -1);
  return out;
}

/** The class strings of `text` (in file `file`, to resolve its imports) holding two base text colours. */
function colourConflicts(text: string, file: string, read = (f: string) => readFileSync(f, "utf8")): string[] {
  const scope = constants(text);
  for (const im of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
    const from = [".ts", ".tsx"].map((x) => join(dirname(file), im[2]) + x).find(existsSync);
    if (!from) continue;
    const exported = constants(read(from));
    for (const name of im[1].split(",").map((n) => n.replace(/^type\s+/, "").trim()))
      if (exported[name] !== undefined) scope[name] ??= exported[name];
  }
  const out: string[] = [];
  const check = (colours: Set<string>, what: string) => {
    if (colours.size > 1) out.push(`${[...colours].join(" + ")} in ${what.trim().slice(0, 80)}`);
  };
  for (const m of text.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    const t = m[1];
    const exprs = [...t.matchAll(/\$\{([^}]*)\}/g)].map((e) => e[1].trim());
    const base = new Set(baseTextColours(t.replace(/\$\{[^}]*\}/g, " ")));
    for (const e of exprs) if (/^\w+$/.test(e) && scope[e] !== undefined) for (const c of baseTextColours(scope[e])) base.add(c);
    check(base, t);
    for (const e of exprs.filter((x) => x.includes("?")))
      for (const branch of e.matchAll(/"([^"]*)"/g)) check(new Set([...base, ...baseTextColours(branch[1])]), t);
  }
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) check(new Set(baseTextColours(m[1])), m[1]);
  return out;
}

test("colourConflicts finds two base text colours in one class string, through constants and branches", () => {
  const consts = 'const btn = "rounded-md bg-btn px-2 text-text hover:bg-seg-sel disabled:text-icon-dim";\n';
  expect(colourConflicts(`${consts}const a = <b className={\`\${btn} text-danger-text\`} />;`, "src/x.tsx")).toHaveLength(1);
  expect(colourConflicts(`${consts}const a = <b className={\`\${btn} \${err ? "text-danger-text" : ""}\`} />;`, "src/x.tsx")).toHaveLength(1);
  expect(colourConflicts('const a = "px-2 text-text text-danger-text";', "src/x.tsx")).toHaveLength(1);
  // One colour per string or per branch, variants, sizes and alignments: fine.
  const base = 'const btnBase = "rounded-md bg-btn px-2 text-sm hover:bg-seg-sel disabled:text-icon-dim";\n';
  expect(colourConflicts(`${base}const a = <b className={\`\${btnBase} text-danger-text\`} />;`, "src/x.tsx")).toEqual([]);
  expect(colourConflicts(`${base}const a = \`\${btnBase} \${err ? "text-danger-text" : "text-text"}\`;`, "src/x.tsx")).toEqual([]);
  expect(colourConflicts('const a = "text-sm text-left text-text hover:text-text-2 aria-invalid:text-danger-text";', "src/x.tsx")).toEqual([]);
});

test("text_colour_conflict_guard: no class string in src/ holds two base text colours (#129)", () => {
  const files = sources("src").filter((f) => /\.tsx?$/.test(f));
  expect(files.length).toBeGreaterThan(100);
  // The guard knows the colours (not an empty list) and resolves the shared style modules.
  expect(COLOURS.has("text")).toBe(true);
  expect(COLOURS.has("danger-text")).toBe(true);
  expect(files).toContain(join("src", "features", "connections", "formStyles.ts"));
  const bad = files.flatMap((f) => colourConflicts(readFileSync(f, "utf8"), f).map((m) => `${f}: ${m}`));
  expect(bad).toEqual([]);
});
