import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { isModalOpen, matchShortcut, useShortcut } from "./shortcuts";

// Tests simulate the platform by spying on `navigator.platform` (lib/platform's isMac reads
// it, unless `navigator.userAgentData.platform` is present, which jsdom lacks).
const platform = (p: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(p);

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

test("Mod is Ctrl off macOS and Meta on macOS", () => {
  platform("Linux x86_64");
  expect(matchShortcut(key({ code: "KeyK", ctrlKey: true }), "Mod+K")).toBe(true);
  expect(matchShortcut(key({ code: "KeyK", metaKey: true }), "Mod+K")).toBe(false);
  platform("MacIntel");
  expect(matchShortcut(key({ code: "KeyK", metaKey: true }), "Mod+K")).toBe(true);
  expect(matchShortcut(key({ code: "KeyK", ctrlKey: true }), "Mod+K")).toBe(false);
});

test("Ctrl is literally Ctrl on every platform", () => {
  platform("MacIntel");
  expect(matchShortcut(key({ code: "Tab", ctrlKey: true }), "Ctrl+Tab")).toBe(true);
  expect(matchShortcut(key({ code: "Tab", metaKey: true }), "Ctrl+Tab")).toBe(false);
});

test("matches on e.code, not e.key", () => {
  platform("Linux x86_64");
  // AZERTY: the physical K key may report another character
  expect(matchShortcut(key({ code: "KeyK", key: "ķ", ctrlKey: true }), "Mod+K")).toBe(true);
  expect(matchShortcut(key({ code: "KeyL", key: "k", ctrlKey: true }), "Mod+K")).toBe(false);
  expect(matchShortcut(key({ code: "Slash", ctrlKey: true }), "Mod+/")).toBe(true);
  expect(matchShortcut(key({ code: "Enter", ctrlKey: true }), "Mod+Enter")).toBe(true);
});

test("modifiers must match exactly", () => {
  platform("Linux x86_64");
  expect(matchShortcut(key({ code: "KeyF", ctrlKey: true, shiftKey: true }), "Mod+Shift+F")).toBe(
    true,
  );
  expect(matchShortcut(key({ code: "KeyF", ctrlKey: true }), "Mod+Shift+F")).toBe(false);
  expect(matchShortcut(key({ code: "KeyF", ctrlKey: true, shiftKey: true }), "Mod+F")).toBe(false);
  expect(matchShortcut(key({ code: "KeyF", ctrlKey: true, altKey: true }), "Mod+F")).toBe(false);
});

test("auto-repeat never matches", () => {
  platform("Linux x86_64");
  expect(matchShortcut(key({ code: "KeyK", ctrlKey: true, repeat: true }), "Mod+K")).toBe(false);
});

test("isModalOpen detects an aria-modal element", () => {
  expect(isModalOpen()).toBe(false);
  document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
  expect(isModalOpen()).toBe(true);
});

test("useShortcut fires on match, skips repeat and modals, and cleans up", () => {
  platform("Linux x86_64");
  const handler = vi.fn();
  const { unmount } = renderHook(() => useShortcut("Mod+K", handler));
  const fire = (init: KeyboardEventInit) =>
    window.dispatchEvent(key({ bubbles: true, cancelable: true, ...init }));

  fire({ code: "KeyK", ctrlKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
  fire({ code: "KeyJ", ctrlKey: true });
  fire({ code: "KeyK", ctrlKey: true, repeat: true });
  expect(handler).toHaveBeenCalledTimes(1);

  document.body.innerHTML = '<div aria-modal="true"></div>';
  fire({ code: "KeyK", ctrlKey: true });
  expect(handler).toHaveBeenCalledTimes(1);

  unmount();
  document.body.innerHTML = "";
  fire({ code: "KeyK", ctrlKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
});

test("useShortcut allowInModal lets a handler run over a modal", () => {
  platform("Linux x86_64");
  const handler = vi.fn();
  renderHook(() => useShortcut("Mod+K", handler, { allowInModal: true }));
  document.body.innerHTML = '<div aria-modal="true"></div>';
  window.dispatchEvent(key({ code: "KeyK", ctrlKey: true }));
  expect(handler).toHaveBeenCalledTimes(1);
});
