import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";

// Read as text: Vitest does not load stylesheets.
const css = readFileSync("src/styles/interaction.css", "utf8");

let style: HTMLStyleElement | null = null;
afterEach(() => {
  style?.remove();
  document.body.innerHTML = "";
});

function cursorOf(html: string): string {
  style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.innerHTML = html;
  return getComputedStyle(document.body.firstElementChild as Element).cursor;
}

test("pointer_cursor: clickable controls show the pointer", () => {
  for (const html of [
    "<button>b</button>",
    '<div role="tab">t</div>',
    '<div role="menuitem">m</div>',
    '<div role="menuitemradio">m</div>',
    '<div role="menuitemcheckbox">m</div>',
    '<div role="option">o</div>',
    '<div role="treeitem">r</div>',
    '<div role="button">b</div>',
    "<select><option>a</option></select>",
    '<input type="checkbox">',
    "<summary>s</summary>",
  ]) {
    expect(cursorOf(html), html).toBe("pointer");
    style?.remove();
  }
});

test("pointer_cursor: disabled controls do not", () => {
  for (const html of [
    "<button disabled>b</button>",
    '<button aria-disabled="true">b</button>',
    '<div role="tab" aria-disabled="true">t</div>',
    '<div role="menuitem" aria-disabled="true">m</div>',
    "<select disabled><option>a</option></select>",
    '<input type="checkbox" disabled>',
  ]) {
    expect(cursorOf(html), html).toBe("default");
    style?.remove();
  }
});

test("tooltip_motion: the entry animation only applies under prefers-reduced-motion: no-preference", () => {
  // Every animation rule sits inside the no-preference block: under reduce, no rule applies
  // (a later override would lose to the more specific animation selectors, review #109).
  const block = css.match(/@media \(prefers-reduced-motion: no-preference\)\s*\{([\s\S]*)\}\s*$/);
  expect(block).not.toBeNull();
  const inside = block![1];
  expect(inside).toMatch(/\.tm-tooltip\[data-animate="true"\]\[data-placement="bottom"\]\s*\{\s*animation:[^;]*120ms/);
  expect(inside).toMatch(/\.tm-tooltip\[data-animate="true"\]\[data-placement="top"\]\s*\{\s*animation:[^;]*120ms/);
  const outside = css.replace(block![0], "");
  expect(outside).not.toMatch(/animation\s*:/);
  expect(css).not.toMatch(/prefers-reduced-motion: reduce/);
});
