import { afterEach, expect, test, vi } from "vitest";
import { SHORTCUTS, currentPlatform, formatShortcut, isMacPlatform } from "./shortcuts";

afterEach(() => vi.unstubAllGlobals());

test("Mod reads Ctrl on Linux and Windows, ⌘ on macOS", () => {
  expect(formatShortcut(["mod", "enter"], "Linux x86_64")).toBe("Ctrl+Enter");
  expect(formatShortcut(["mod", "shift", "enter"], "Win32")).toBe("Ctrl+Shift+Enter");
  expect(formatShortcut(["mod", "enter"], "MacIntel")).toBe("⌘+Enter");
  expect(formatShortcut(["mod", "comma"], "macOS")).toBe("⌘+,");
  // A literal Ctrl stays Ctrl everywhere (WorkspaceView checks ctrlKey only).
  expect(formatShortcut(["ctrl", "t"], "MacIntel")).toBe("Ctrl+T");
});

test("macOS detection", () => {
  expect(isMacPlatform("MacIntel")).toBe(true);
  expect(isMacPlatform("macOS")).toBe(true);
  expect(isMacPlatform("Linux x86_64")).toBe(false);
  expect(isMacPlatform("Win32")).toBe(false);
  expect(isMacPlatform("")).toBe(false);
});

test("the platform comes from userAgentData, else navigator.platform", () => {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  expect(currentPlatform()).toBe("MacIntel");
  vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgentData: { platform: "macOS" } });
  expect(currentPlatform()).toBe("macOS");
});

test("no shortcut is shown with a literal Mod", () => {
  for (const platform of ["Linux x86_64", "MacIntel"]) {
    for (const s of SHORTCUTS) expect(formatShortcut(s.keys, platform)).not.toMatch(/Mod/);
  }
});
