import { afterEach, expect, test, vi } from "vitest";
import { KEYMAP_ACTIONS } from "./keymap";
import { currentPlatform, formatShortcut, isMac, isModKey } from "./platform";

afterEach(() => vi.restoreAllMocks());

test("macOS detection from arguments", () => {
  expect(isMac("MacIntel", "")).toBe(true);
  expect(isMac("macOS", "")).toBe(true);
  expect(isMac("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe(true);
  expect(isMac("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  expect(isMac("Win32", "")).toBe(false);
  expect(isMac("", "")).toBe(false);
});

test("macOS detection from the navigator", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  expect(isMac()).toBe(true);
  expect(formatShortcut("Mod+S")).toBe("⌘+S");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(isMac()).toBe(false);
  expect(formatShortcut("Mod+S")).toBe("Ctrl+S");
});

test("the platform comes from userAgentData, else navigator.platform", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  expect(currentPlatform()).toBe("MacIntel");
  vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgentData: { platform: "macOS" } });
  expect(currentPlatform()).toBe("macOS");
  vi.unstubAllGlobals();
});

test("Mod is Cmd on macOS and Ctrl elsewhere", () => {
  const e = (ctrlKey: boolean, metaKey: boolean) => ({ ctrlKey, metaKey });
  expect(isModKey(e(true, false), false)).toBe(true);
  expect(isModKey(e(false, true), false)).toBe(false);
  expect(isModKey(e(false, true), true)).toBe(true);
  expect(isModKey(e(true, false), true)).toBe(false);
});

test("formatShortcut reads Mod as Ctrl or ⌘", () => {
  expect(formatShortcut("Mod+Enter", false)).toBe("Ctrl+Enter");
  expect(formatShortcut("Mod+Shift+Enter", false)).toBe("Ctrl+Shift+Enter");
  expect(formatShortcut("Mod+Shift+Enter", true)).toBe("⌘+Shift+Enter");
  expect(formatShortcut("Mod+,", true)).toBe("⌘+,");
  expect(formatShortcut("Mod+/", false)).toBe("Ctrl+/");
  expect(formatShortcut("Mod+s", true)).toBe("⌘+S");
});

test("a literal Ctrl stays Ctrl on macOS, Alt reads ⌥ there", () => {
  expect(formatShortcut("Ctrl+T", true)).toBe("Ctrl+T");
  expect(formatShortcut("Alt+1", true)).toBe("⌥+1");
  expect(formatShortcut("Alt+1", false)).toBe("Alt+1");
});

test("Meta reads ⌘ on macOS and Super elsewhere", () => {
  expect(formatShortcut("Meta+K", true)).toBe("⌘+K");
  expect(formatShortcut("Meta+K", false)).toBe("Super+K");
  expect(formatShortcut("Meta+Shift+Enter", false)).toBe("Super+Shift+Enter");
  expect(formatShortcut("Mod+K", true)).toBe("⌘+K");
});

test("odd specs do not crash", () => {
  expect(() => formatShortcut("Mod++", false)).not.toThrow();
  expect(formatShortcut("", false)).toBe("");
});

test("no keymap default is shown with a literal Mod", () => {
  for (const mac of [false, true]) {
    for (const a of KEYMAP_ACTIONS) expect(formatShortcut(a.defaultShortcut, mac)).not.toMatch(/Mod/);
  }
});

test("arrow keys read as arrows", () => {
  expect(formatShortcut("Alt+ArrowLeft", false)).toBe("Alt+←");
  expect(formatShortcut("Alt+ArrowLeft", true)).toBe("⌥+←");
  expect(formatShortcut("Mod+ArrowRight", false)).toBe("Ctrl+→");
  expect(formatShortcut("Shift+ArrowUp", false)).toBe("Shift+↑");
  expect(formatShortcut("Shift+ArrowDown", false)).toBe("Shift+↓");
  expect(formatShortcut("Mod+Backspace", false)).toBe("Ctrl+Backspace");
});
