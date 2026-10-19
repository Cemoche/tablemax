import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import * as ipc from "./ipc";
import { applyInterfaceScale, applyTheme, useResolvedDark } from "./theme";

vi.mock("./ipc");

function stubOs(dark: boolean) {
  vi.stubGlobal("matchMedia", () => ({
    matches: dark,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

test("applyTheme sets and removes data-theme", () => {
  applyTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  applyTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  applyTheme("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

test("useResolvedDark follows the OS when no theme is forced", () => {
  stubOs(true);
  const { result } = renderHook(() => useResolvedDark());
  expect(result.current).toBe(true);
});

test("useResolvedDark reacts to a data-theme change while the OS is light", async () => {
  stubOs(false);
  const { result } = renderHook(() => useResolvedDark());
  expect(result.current).toBe(false);
  act(() => applyTheme("dark"));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => applyTheme("system"));
  await waitFor(() => expect(result.current).toBe(false));
});

test("a forced light theme wins over a dark OS", () => {
  stubOs(true);
  applyTheme("light");
  const { result } = renderHook(() => useResolvedDark());
  expect(result.current).toBe(false);
});

test("useResolvedDark reacts to an OS color-scheme change", () => {
  let handler: (() => void) | undefined;
  const mq = {
    matches: false,
    addEventListener: (_: string, h: () => void) => (handler = h),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => mq);
  const { result, unmount } = renderHook(() => useResolvedDark());
  expect(result.current).toBe(false);
  mq.matches = true;
  act(() => handler?.());
  expect(result.current).toBe(true);
  unmount();
  expect(mq.removeEventListener).toHaveBeenCalled();
});

test("applyInterfaceScale sets the native zoom and swallows a failure", async () => {
  vi.mocked(ipc.windowSetZoom).mockRejectedValue({ kind: "io", message: "no window" });
  expect(() => applyInterfaceScale(1.3)).not.toThrow();
  expect(ipc.windowSetZoom).toHaveBeenCalledWith(1.3);
  // The rejection is handled: no unhandled rejection fails the run.
  await Promise.resolve();
});
