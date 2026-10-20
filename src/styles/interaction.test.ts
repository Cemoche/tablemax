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
