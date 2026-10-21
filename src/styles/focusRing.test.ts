import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
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

// Structural guard (#135 review): a focusable element that never mentions `outline-none` falls
// back to the browser's ring, which the scans above cannot see. Every <button>, <input> (not
// hidden), <select>, <textarea>, <a href> and element with a tabIndex other than -1 must draw
// the shared ring, through its className: literals, and constants of the file or of a module
// it imports (`${btn}`, `{field}`), resolved like textColor.test.ts does.

/**
 * String constants of a source text by name: `const x = "…"` (or a template), and the string
 * properties of its objects (`button: \`…\``, read for `style.button`) under `.button`.
 */
function constants(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // A constant, or a function of a few arguments returning one (`const tab = (on) => \`…\``).
  const value = /(?:^|\n)\s*(?:export )?const (\w+)\s*=\s*(?:\([^()]*\)\s*=>\s*)?("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
  for (const m of text.matchAll(value)) out[m[1]] = m[2].slice(1, -1);
  for (const m of text.matchAll(/\n\s*(\w+):\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`),/g)) out[`.${m[1]}`] ??= m[2].slice(1, -1);
  return out;
}

/** `expr` with the names of `scope` replaced by their values, a few levels deep (constants built from constants). */
function resolve(expr: string, scope: Record<string, string>): string {
  let out = expr;
  for (let i = 0; i < 4; i++) {
    out = out.replace(/\.([A-Za-z_]\w*)\b/g, (m, name) => (scope[`.${name}`] !== undefined ? ` ${scope[`.${name}`]} ` : m));
    out = out.replace(/\b[A-Za-z_]\w*\b/g, (name) => (scope[name] !== undefined ? ` ${scope[name]} ` : name));
  }
  return out;
}

/** The constants a file sees: its own, then those it imports from relative modules (resolved there). */
function scopeOf(text: string, file: string, depth = 0): Record<string, string> {
  const scope = constants(text);
  if (depth > 2) return scope;
  for (const im of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
    const from = [".ts", ".tsx"].map((x) => join(dirname(file), im[2]) + x).find(existsSync);
    if (!from) continue;
    const theirs = scopeOf(readFileSync(from, "utf8"), from, depth + 1);
    for (const name of im[1].split(",").map((n) => n.replace(/^type\s+/, "").trim()))
      if (theirs[name] !== undefined) scope[name] ??= resolve(theirs[name], theirs);
  }
  return scope;
}

/** The end (index after `>`) of the JSX opening tag starting at `start`, skipping braces and strings. */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      // A string: skip to its end (template expressions hold no backtick in our sources).
      const close = text.indexOf(c, i + 1);
      if (close < 0) return text.length;
      i = close;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && text[i - 1] !== "=") return i + 1;
  }
  return text.length;
}

/** The value of attribute `name` in an opening tag: a string, a `{…}` expression, or null. */
function attr(tag: string, name: string): string | null {
  const at = tag.search(new RegExp(`\\s${name}=`));
  if (at < 0) return null;
  const v = at + name.length + 2;
  if (tag[v] === '"') return tag.slice(v + 1, tag.indexOf('"', v + 1));
  if (tag[v] !== "{") return null;
  let depth = 0;
  for (let i = v; i < tag.length; i++) {
    const c = tag[i];
    if (c === '"' || c === "'" || c === "`") i = tag.indexOf(c, i + 1);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return tag.slice(v + 1, i);
  }
  return null;
}

/** Components that hand their className to a focusable element: their call sites are scanned. */
const FORWARDING = ["MenuButton"];

/** The focusable elements of a TSX text whose className does not draw the shared ring. */
function unringedFocusables(source: string, file: string): string[] {
  const scope = scopeOf(source, file);
  // Comments may name a tag (`<select>` values…): blank them, keeping the line numbers.
  const text = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\w])\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
  const out: string[] = [];
  for (const m of text.matchAll(/<([a-z]+|[A-Z]\w*)(?=[\s>])/g)) {
    const tag = text.slice(m.index, tagEnd(text, m.index));
    const name = m[1];
    const tabIndex = attr(tag, "tabIndex");
    // tabIndex -1: focused by code or by a click only, never by the keyboard.
    if (tabIndex?.trim() === "-1") continue;
    const tabStop = tabIndex !== null;
    const focusable =
      ["button", "select", "textarea", ...FORWARDING].includes(name) ||
      (name === "input" && attr(tag, "type") !== "hidden") ||
      (name === "a" && attr(tag, "href") !== null) ||
      tabStop;
    if (!focusable) continue;
    const classes = resolve(attr(tag, "className") ?? "", scope);
    if (!classes.split(/[\s"'`{}$(),?:]+|\s/).some((t) => SHARED_RING.test(t)) && !/\S*focus\S*:focus-ring(?:-inset)?\b/.test(classes))
      out.push(`line ${text.slice(0, m.index).split("\n").length}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
  }
  return out;
}

/**
 * Focusables without the ring, "file: piece of the tag" → reason. Each one shows its focus
 * another way.
 */
const UNRINGED_ALLOWED: { file: string; has: string; reason: string }[] = [
  {
    file: "src/features/connections/ConnectionForm.tsx",
    has: '<input type="radio" name={colorName}',
    reason: "an invisible radio over its swatch: the swatch's label draws the ring (has-[:focus-visible])",
  },
  {
    file: "src/features/grid/RowDetailPanel.tsx",
    has: '<input type="search"',
    reason: "the search input: its field draws the ring (focus-within)",
  },
  {
    file: "src/features/sidebar/SidebarSearch.tsx",
    has: '<input ref={input} type="search"',
    reason: "the search input: its field draws the ring (focus-within)",
  },
  {
    file: "src/features/grid/CellEditorOverlay.tsx",
    has: "<textarea",
    reason: "the cell editor, focused on open over the grid's focused cell; the caret shows the focus",
  },
  {
    file: "src/features/grid/MenuButton.tsx",
    has: "<button ref={button}",
    reason: "takes its caller's className: the <MenuButton> call sites are scanned (FORWARDING)",
  },
];

test("unringedFocusables finds focusables without the shared ring, through constants", () => {
  const f = "src/x.tsx";
  expect(unringedFocusables('<button type="button" onClick={go}>Go</button>', f)).toHaveLength(1);
  expect(unringedFocusables('<button className="px-2 hover:bg-seg-sel">Go</button>', f)).toHaveLength(1);
  expect(unringedFocusables('<input value={v} onChange={(e) => set(e.target.value)} />', f)).toHaveLength(1);
  expect(unringedFocusables('<a href="#x" className="underline">x</a>', f)).toHaveLength(1);
  expect(unringedFocusables('<div tabIndex={0} className="p-2" />', f)).toHaveLength(1);
  expect(unringedFocusables('<li tabIndex={on ? 0 : -1} className="p-2" />', f)).toHaveLength(1);
  // Ringed, directly, through a constant (even a constant of constants) or a branch.
  expect(unringedFocusables('<button className="outline-none focus-visible:focus-ring">Go</button>', f)).toEqual([]);
  const consts = 'const ring = "outline-none focus-visible:focus-ring-inset";\nconst btn = `px-2 ${ring}`;\n';
  expect(unringedFocusables(`${consts}<button className={btn} onClick={() => a > b}>Go</button>`, f)).toEqual([]);
  expect(unringedFocusables(`${consts}<select className={\`\${btn} w-full\`} />`, f)).toEqual([]);
  expect(unringedFocusables('<textarea className={`p-1 ${x ? "a" : "b"} focus-within:focus-ring-inset`} />', f)).toEqual([]);
  // A component forwarding its className, a function constant, a tag named in a comment.
  expect(unringedFocusables('<MenuButton label="x" className="px-2">x</MenuButton>', f)).toHaveLength(1);
  const tab = 'const tab = (on: boolean) =>\n  `px-2 outline-none focus-visible:focus-ring ${on ? "a" : "b"}`;\n';
  expect(unringedFocusables(`${tab}<button className={tab(v === w)} />`, f)).toEqual([]);
  expect(unringedFocusables("// <select> values\n/* <button> */ const a = 1;", f)).toEqual([]);
  // Not focusable: hidden inputs, links without href, tabIndex -1, other elements.
  expect(unringedFocusables('<input type="hidden" name="x" />', f)).toEqual([]);
  expect(unringedFocusables('<a className="x">x</a>', f)).toEqual([]);
  expect(unringedFocusables('<div tabIndex={-1} className="p-2" />', f)).toEqual([]);
  expect(unringedFocusables('<button tabIndex={-1} aria-hidden="true" className="p-2" />', f)).toEqual([]);
  expect(unringedFocusables('<div className="p-2" />', f)).toEqual([]);
});

test("focus_ring_everywhere: every focusable element draws the shared ring, or UNRINGED_ALLOWED says why (#135)", () => {
  const files = appSources().filter((f) => f.endsWith(".tsx"));
  // The scan resolves the shared style modules (formStyles, toolbarStyles…).
  expect(files).toContain(join("src", "features", "connections", "ConnectionForm.tsx"));
  const bad = files.flatMap((f) =>
    unringedFocusables(readFileSync(f, "utf8"), f)
      .filter((m) => !UNRINGED_ALLOWED.some((a) => a.file === f && m.includes(a.has)))
      .map((m) => `${f}: ${m}`),
  );
  expect(bad).toEqual([]);
  for (const a of UNRINGED_ALLOWED) {
    expect(unringedFocusables(readFileSync(a.file, "utf8"), a.file).some((m) => m.includes(a.has)), `${a.file}: ${a.has}`).toBe(true);
  }
});
