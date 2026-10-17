import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { buildEditThemes, buildGridTheme, useGridTheme } from "./gridTheme";

afterEach(() => vi.unstubAllGlobals());

test("empty tokens fall back to usable values", () => {
  const t = buildGridTheme(() => "");
  expect(t.bgCell).toBe("Canvas");
  expect(t.textDark).toBe("CanvasText");
  expect(t.baseFontStyle).toBe("13px");
  expect(t.fontFamily).toBeTruthy();
});

test("reads tokens", () => {
  const t = buildGridTheme((n) => (n === "--surface" ? "#111" : n === "--text-muted" ? "#888" : ""));
  expect(t.bgCell).toBe("#111");
  expect(t.textMedium).toBe("#888");
});

test("theme is rebuilt on a color-scheme media change and listener is removed", () => {
  let handler: (() => void) | undefined;
  const removeEventListener = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    addEventListener: (_: string, h: () => void) => (handler = h),
    removeEventListener,
  }));
  let bg = "#fff";
  const read = (n: string) => (n === "--surface" ? bg : "");
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
    "--pending-edit": "#e1",
    "--pending-insert": "#e2",
    "--pending-delete": "#e3",
    "--danger": "#e4",
    "--text-muted": "#e5",
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
    n === "--surface" ? (document.documentElement.dataset.theme === "dark" ? "#000" : "#fff") : "";
  const { result } = renderHook(() => useGridTheme(read));
  expect(result.current.theme.bgCell).toBe("#fff");
  act(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await waitFor(() => expect(result.current.theme.bgCell).toBe("#000"));
  delete document.documentElement.dataset.theme;
});
