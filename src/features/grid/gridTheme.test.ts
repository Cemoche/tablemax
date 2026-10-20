/// <reference types="node" />
import { readFileSync } from "node:fs";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { contrastRatio } from "../../lib/contrast";
import { buildEditThemes, buildGridTheme, buildRowNumberColors, buildRowThemes, headerFont, useGridTheme } from "./gridTheme";

afterEach(() => vi.unstubAllGlobals());

test("empty tokens fall back to usable values", () => {
  const t = buildGridTheme(() => "");
  expect(t.bgCell).toBe("Canvas");
  expect(t.textDark).toBe("CanvasText");
  expect(t.baseFontStyle).toBe("13px");
  expect(t.fontFamily).toBeTruthy();
});

const vars: Record<string, string> = {
  "--row-a": "#111",
  "--row-b": "#1b1",
  "--grid-head": "#222",
  "--head-text": "#333",
  "--cell-text": "#444",
  "--text-2": "#555",
  "--placeholder": "#666",
  "--grid-sep": "#777",
  "--accent": "#888",
  "--row-selected-text": "#999",
  "--cell-focus": "#f42",
  "--row-selected": "#06c",
  "--sel": "#464",
  "--font-mono": '"JetBrains Mono", ui-monospace, monospace',
  "--font-ui": "system-ui, sans-serif",
  "--text-md": "13px",
};
const read = (n: string) => vars[n] ?? "";

test("reads the grid tokens", () => {
  const t = buildGridTheme(read);
  expect(t).toMatchObject({
    bgCell: "#111",
    bgHeader: "#222",
    textHeader: "#333",
    textDark: "#444",
    textMedium: "#555",
    textLight: "#666",
    borderColor: "#777",
    horizontalBorderColor: "#777",
    // The active cell's border.
    accentColor: "#f42",
    accentFg: "#999",
    linkColor: "#888",
  });
});

test("data in the mono font at the data font size, headers in the interface font (medium)", () => {
  const t = buildGridTheme(read, 15);
  expect(t.fontFamily).toBe('"JetBrains Mono", ui-monospace, monospace');
  expect(t.baseFontStyle).toBe("15px");
  expect(t.headerFontStyle).toBe("500 13px");
  expect(headerFont(read)).toBe("500 13px system-ui, sans-serif");
});

test("zebra_rows: odd rows use --row-b, selected rows --row-selected (the deeper accent) with white text (#103)", () => {
  const r = buildRowThemes(read);
  expect(r.odd).toEqual({ bgCell: "#1b1" });
  expect(r.selected).toMatchObject({
    bgCell: "#06c",
    textDark: "#999",
    textLight: "#999",
    accentLight: "#06c",
  });
});

test("row numbers: the interface font, the header's colours, and the selected row's fill and text (#103)", () => {
  expect(buildRowNumberColors(read)).toEqual({
    family: "system-ui, sans-serif",
    fill: "#222",
    text: "#333",
    selectedFill: "#06c",
    selectedText: "#999",
  });
  // Smaller than the data.
  expect(buildGridTheme(read, 13).markerFontStyle).toBe("11px");
  const { result } = renderHook(() => useGridTheme(read, 13));
  expect(result.current.rowNumbers.selectedFill).toBe("#06c");
  expect(result.current.rowNumbers.fill).toBe("#222");
});

test("placeholders_uppercase_dim: NULL / EMPTY / DEFAULT use --placeholder, 1.5 px under the data size", () => {
  const { result } = renderHook(() => useGridTheme(read, 13));
  expect(result.current.muted).toEqual({ textDark: "#666", baseFontStyle: "11.5px" });
});

test("theme is rebuilt on a color-scheme media change and listener is removed", () => {
  let handler: (() => void) | undefined;
  const removeEventListener = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    addEventListener: (_: string, h: () => void) => (handler = h),
    removeEventListener,
  }));
  let bg = "#fff";
  const read = (n: string) => (n === "--row-a" ? bg : "");
  const { result, unmount } = renderHook(() => useGridTheme(read));
  expect(result.current.theme.bgCell).toBe("#fff");
  bg = "#000";
  act(() => handler?.());
  expect(result.current.theme.bgCell).toBe("#000");
  unmount();
  expect(removeEventListener).toHaveBeenCalled();
});

test("pending-change themes read their tokens", () => {
  const vars: Record<string, string> = {
    "--modified": "#e1",
    "--inserted": "#e2",
    "--deleted": "#e3",
    "--danger": "#e4",
    "--text-2": "#e5",
  };
  const t = buildEditThemes((n) => vars[n] ?? "");
  expect(t.edited.bgCell).toBe("#e1");
  expect(t.inserted.bgCell).toBe("#e2");
  expect(t.deleted).toEqual({ bgCell: "#e3", textDark: "#e5" });
  expect(t.failed.textDark).toBe("#e4");
  // Missing tokens: no override rather than a hardcoded color.
  expect(buildEditThemes(() => "").edited).toEqual({});
});

test("theme is rebuilt when data-theme changes while the OS stays light", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const read = (n: string) =>
    n === "--row-a" ? (document.documentElement.dataset.theme === "dark" ? "#000" : "#fff") : "";
  const { result } = renderHook(() => useGridTheme(read));
  expect(result.current.theme.bgCell).toBe("#fff");
  act(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await waitFor(() => expect(result.current.theme.bgCell).toBe("#000"));
  delete document.documentElement.dataset.theme;
});

test("the grid draws with the fallback mono font until JetBrains Mono is loaded, then redraws with it", async () => {
  let resolve: () => void = () => {};
  const load = vi.fn(() => new Promise<void>((r) => (resolve = r)));
  const fonts = { check: vi.fn(() => false), load };
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
  try {
    const { result } = renderHook(() => useGridTheme(read, 13));
    expect(result.current.theme.fontFamily).toBe("ui-monospace, monospace");
    expect(load).toHaveBeenCalledWith('13px "JetBrains Mono", ui-monospace, monospace');
    const before = result.current.theme;
    await act(async () => resolve());
    // A new theme object: Glide redraws every cell, its text metrics keyed by the new font.
    expect(result.current.theme).not.toBe(before);
    expect(result.current.theme.fontFamily).toBe('"JetBrains Mono", ui-monospace, monospace');
  } finally {
    delete (document as { fonts?: unknown }).fonts;
  }
});

/** The custom properties of the first `selector {` block of tokens.css (read from disk). */
function tokenBlock(selector: string): Record<string, string> {
  const css = readFileSync("src/styles/tokens.css", "utf8");
  const start = css.indexOf(`${selector} {`);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, css.indexOf("}", start)).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

test("an edited cell on a selected row keeps --modified and readable text, in both themes (fix 1)", () => {
  const light = tokenBlock(":root");
  const dark = { ...light, ...tokenBlock(':root[data-theme="dark"]') };
  for (const [name, vars] of [["light", light], ["dark", dark]] as const) {
    const t = buildEditThemes((n) => vars[n] ?? "").editedOnAccent;
    expect(t.bgCell, name).toBe(vars["--modified"]);
    expect(contrastRatio(t.textDark!, t.bgCell!), name).toBeGreaterThanOrEqual(4.5);
    // Glide fills a selected cell (a row selected by its number, the active cell's range)
    // with the theme's opaque accentLight over bgCell: it must stay --modified, under the
    // same readable text, or the edit would show as #262626 on the accent (3.8:1).
    expect(t.accentLight, name).toBe(t.bgCell);
    expect(contrastRatio(t.textDark!, t.accentLight!), name).toBeGreaterThanOrEqual(4.5);
    // Links and placeholders on it use the same colour.
    expect(t.linkColor, name).toBe(t.textDark);
    expect(t.textLight, name).toBe(t.textDark);
  }
  // Tokens that cannot be compared (missing or not hex) fall back to --cell-text.
  expect(buildEditThemes((n) => (n === "--modified" ? "rgb(1 2 3)" : n === "--cell-text" ? "#111" : "")).editedOnAccent)
    .toMatchObject({ bgCell: "rgb(1 2 3)", textDark: "#111" });
});
