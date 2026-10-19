/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Read from disk (path from the repo root, where vitest runs): vitest replaces CSS
// imports, even `?raw`, with an empty module.
const css = readFileSync("src/styles/tokens.css", "utf8");

/** Custom properties declared in the first block opened by `selector`. */
function declared(selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
}

// Dark values are written twice (OS dark media block and forced data-theme="dark"): a
// token missing from one of them keeps its light value in that mode.
test("both dark blocks override the same tokens", () => {
  const media = declared(':root:not([data-theme="light"])');
  const forced = declared(':root[data-theme="dark"]');
  expect(forced).toEqual(media);
  expect(forced).toEqual(expect.arrayContaining(["--pending-edit", "--pending-insert", "--pending-delete"]));
});

test("every dark token has a light default", () => {
  const light = declared(":root");
  for (const t of declared(':root[data-theme="dark"]')) expect(light, t).toContain(t);
});
