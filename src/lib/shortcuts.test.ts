import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_KEYMAP, type KeymapActionId, effectiveShortcuts, isValidShortcut } from "./keymapRegistry";
import {
  __setNonLatinLayoutForTests,
  installLayoutTracker,
  isModalOpen,
  keyPressOf,
  matchCombination,
  matchShortcut,
  nonLatinLayout,
  typesCharacter,
  useShortcut,
} from "./shortcuts";
import { LAYOUTS, type LayoutName, describePress, presses } from "../test/layouts";

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

test("letters follow the layout: e.key when it is a Latin letter", () => {
  platform("Linux x86_64");
  // AZERTY: the key at QWERTY's W types "z", the key at QWERTY's Z types "w".
  expect(matchShortcut(key({ code: "KeyW", key: "z", ctrlKey: true }), "Mod+W")).toBe(false);
  expect(matchShortcut(key({ code: "KeyW", key: "z", ctrlKey: true }), "Mod+Z")).toBe(true);
  expect(matchShortcut(key({ code: "KeyZ", key: "w", ctrlKey: true }), "Mod+W")).toBe(true);
  expect(matchShortcut(key({ code: "KeyQ", key: "a", ctrlKey: true }), "Mod+A")).toBe(true);
  expect(matchShortcut(key({ code: "KeyQ", key: "a", ctrlKey: true }), "Mod+Q")).toBe(false);
  // Shift: e.key is uppercase and still matches.
  expect(matchShortcut(key({ code: "KeyZ", key: "W", ctrlKey: true, shiftKey: true }), "Mod+Shift+W")).toBe(true);
  expect(matchShortcut(key({ code: "KeyF", key: "F", ctrlKey: true, shiftKey: true }), "Mod+Shift+F")).toBe(true);
  // A letter position that types a shortcut character (AZERTY's M position types ",") is
  // that character's, not the letter's (#105).
  expect(matchShortcut(key({ code: "KeyM", key: ",", ctrlKey: true }), "Mod+M")).toBe(false);
  expect(matchShortcut(key({ code: "KeyM", key: ",", ctrlKey: true }), "Mod+,")).toBe(true);
  // A synthetic event with no key falls back on the position.
  expect(matchShortcut(key({ code: "KeyK", ctrlKey: true }), "Mod+K")).toBe(true);
});

test("on a non-Latin layout (Cyrillic, Greek) letters match by physical key", () => {
  platform("Linux x86_64");
  expect(matchShortcut(key({ code: "KeyW", key: "ц", ctrlKey: true }), "Mod+W")).toBe(true);
  expect(matchShortcut(key({ code: "KeyW", key: "Ц", ctrlKey: true, shiftKey: true }), "Mod+Shift+W")).toBe(true);
  expect(matchShortcut(key({ code: "KeyT", key: "τ", ctrlKey: true }), "Mod+T")).toBe(true);
  expect(matchShortcut(key({ code: "KeyK", key: "ķ", ctrlKey: true }), "Mod+K")).toBe(true);
  // macOS: Option types a character (Cmd+Option+F reports "ƒ"), a dead key reports "Dead".
  platform("MacIntel");
  expect(matchShortcut(key({ code: "KeyF", key: "ƒ", metaKey: true, altKey: true }), "Mod+Alt+F")).toBe(true);
  expect(matchShortcut(key({ code: "KeyE", key: "Dead", altKey: true }), "Alt+E")).toBe(true);
});

test("digits and named keys by position; letters and typed punctuation beat positions", () => {
  platform("Linux x86_64");
  // AZERTY: the digit row types "&é\"'(" without Shift.
  expect(matchShortcut(key({ code: "Digit1", key: "&", ctrlKey: true }), "Mod+1")).toBe(true);
  expect(matchShortcut(key({ code: "Digit2", key: "é", ctrlKey: true }), "Mod+2")).toBe(true);
  expect(matchShortcut(key({ code: "Digit1", key: "&", altKey: true }), "Alt+1")).toBe(true);
  expect(matchShortcut(key({ code: "Slash", key: "/", ctrlKey: true }), "Mod+/")).toBe(true);
  expect(matchShortcut(key({ code: "Enter", key: "Enter", ctrlKey: true }), "Mod+Enter")).toBe(true);
  expect(matchShortcut(key({ code: "BracketLeft", key: "[", ctrlKey: true }), "Mod+[")).toBe(true);
  // A key that types a letter is that letter's (AZERTY's ";" position types "m"; Dvorak's
  // "," position types "w"), never the punctuation's.
  expect(matchShortcut(key({ code: "Semicolon", key: "m", ctrlKey: true }), "Mod+;")).toBe(false);
  expect(matchShortcut(key({ code: "Semicolon", key: "m", ctrlKey: true }), "Mod+M")).toBe(true);
  expect(matchShortcut(key({ code: "Comma", key: "w", ctrlKey: true }), "Mod+,")).toBe(false);
});

test("keyPressOf names a keydown as the matching reads it", () => {
  const name = (init: KeyboardEventInit) => keyPressOf(key(init));
  expect(name({ code: "KeyW", key: "z" })).toEqual({ key: "Z", shift: false });
  expect(name({ code: "KeyW", key: "ц" })).toEqual({ key: "W", shift: false });
  expect(name({ code: "KeyM", key: "," })).toEqual({ key: ",", shift: false });
  expect(name({ code: "KeyW", key: "'" })).toEqual({ key: "W", shift: false });
  expect(name({ code: "Semicolon", key: "m" })).toEqual({ key: "M", shift: false });
  expect(name({ code: "Digit1", key: "&" })).toEqual({ key: "1", shift: false });
  expect(name({ code: "Comma", key: ";" })).toEqual({ key: ";", shift: false });
  expect(name({ code: "Period", key: ":" })).toEqual({ key: ".", shift: false });
  expect(name({ code: "BracketLeft", key: "Dead" })).toEqual({ key: "[", shift: false });
  expect(name({ code: "KeyZ", key: "W", shiftKey: true })).toEqual({ key: "W", shift: true });
  expect(name({ code: "NumpadEnter", key: "Enter" })).toEqual({ key: "Enter", shift: false });
  expect(name({ code: "NumpadDivide", key: "/" })).toEqual({ key: "", shift: false });
  expect(name({ code: "F5", key: "F5" })).toEqual({ key: "F5", shift: false });
  expect(name({ code: "Enter", key: "Enter", shiftKey: true })).toEqual({ key: "Enter", shift: true });
  expect(name({ code: "IntlBackslash", key: "<" })).toEqual({ key: "", shift: false });
  // On a non-Latin layout (#131): punctuation and letter positions by US position; a Latin
  // letter typed is still that letter.
  __setNonLatinLayoutForTests(true);
  expect(name({ code: "KeyW", key: "'" })).toEqual({ key: "W", shift: false });
  expect(name({ code: "KeyQ", key: "/" })).toEqual({ key: "Q", shift: false });
  expect(name({ code: "Slash", key: "." })).toEqual({ key: "/", shift: false });
  expect(name({ code: "Backslash", key: "/", shiftKey: true })).toEqual({ key: "\\", shift: true });
  expect(name({ code: "BracketLeft", key: "}", shiftKey: true })).toEqual({ key: "[", shift: true });
  expect(name({ code: "KeyW", key: "W", shiftKey: true })).toEqual({ key: "W", shift: true });
  expect(name({ code: "Digit7", key: "?", shiftKey: true })).toEqual({ key: "7", shift: true });
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

test("isModalOpen ignores a modal inside a hidden subtree (a form kept behind a workspace, #88)", () => {
  document.body.innerHTML = '<main hidden><div><div role="dialog" aria-modal="true"></div></div></main>';
  expect(isModalOpen()).toBe(false);
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true"></div>');
  expect(isModalOpen()).toBe(true);
  document.body.innerHTML = "";
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

test("useShortcut capture + stopPropagation runs before, and hides the key from, a child's listener", () => {
  platform("Linux x86_64");
  const child = document.createElement("div");
  document.body.appendChild(child);
  const childKey = vi.fn();
  child.addEventListener("keydown", childKey);
  const handler = vi.fn();
  renderHook(() => useShortcut("Alt+1", handler, { capture: true, stopPropagation: true }));
  child.dispatchEvent(key({ code: "Digit1", altKey: true, bubbles: true, cancelable: true }));
  expect(handler).toHaveBeenCalledTimes(1);
  expect(childKey).not.toHaveBeenCalled();
  // Other keys still reach the child.
  child.dispatchEvent(key({ code: "Digit3", altKey: true, bubbles: true, cancelable: true }));
  expect(childKey).toHaveBeenCalledTimes(1);
});

test("without stopPropagation the event still reaches the child after a capture handler", () => {
  platform("Linux x86_64");
  const child = document.createElement("div");
  document.body.appendChild(child);
  const order: string[] = [];
  child.addEventListener("keydown", () => order.push("child"));
  renderHook(() => useShortcut("Alt+ArrowLeft", () => order.push("shortcut"), { capture: true }));
  child.dispatchEvent(key({ code: "ArrowLeft", altKey: true, bubbles: true, cancelable: true }));
  expect(order).toEqual(["shortcut", "child"]);
});

test("useShortcut skipInEditable ignores keys typed in a field", () => {
  platform("Linux x86_64");
  const handler = vi.fn();
  renderHook(() => useShortcut("Alt+1", handler, { skipInEditable: true }));
  const fire = (target: Element) =>
    target.dispatchEvent(key({ code: "Digit1", altKey: true, bubbles: true, cancelable: true }));
  for (const tag of ["input", "textarea", "select"]) {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    fire(el);
  }
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  // jsdom does not compute isContentEditable from the attribute.
  Object.defineProperty(editable, "isContentEditable", { value: true });
  document.body.appendChild(editable);
  fire(editable);
  expect(handler).not.toHaveBeenCalled();
  fire(document.body);
  expect(handler).toHaveBeenCalledTimes(1);
});

test("useShortcut enabled: false registers nothing", () => {
  platform("Linux x86_64");
  const handler = vi.fn();
  const { rerender } = renderHook(({ on }) => useShortcut("Mod+I", handler, { enabled: on }), {
    initialProps: { on: false },
  });
  const ev = () => key({ code: "KeyI", ctrlKey: true, cancelable: true });
  const e1 = ev();
  window.dispatchEvent(e1);
  expect(handler).not.toHaveBeenCalled();
  expect(e1.defaultPrevented).toBe(false);
  rerender({ on: true });
  window.dispatchEvent(ev());
  expect(handler).toHaveBeenCalledTimes(1);
});

test("useShortcut follows a new spec without remounting", () => {
  platform("Linux x86_64");
  const handler = vi.fn();
  const { rerender } = renderHook(({ spec }) => useShortcut(spec, handler), { initialProps: { spec: "Mod+K" } });
  rerender({ spec: "Mod+Shift+K" });
  window.dispatchEvent(key({ code: "KeyK", ctrlKey: true }));
  expect(handler).not.toHaveBeenCalled();
  window.dispatchEvent(key({ code: "KeyK", ctrlKey: true, shiftKey: true }));
  expect(handler).toHaveBeenCalledTimes(1);
});

test("matchCombination is matchShortcut without the auto-repeat rule", () => {
  platform("Linux x86_64");
  expect(matchCombination(key({ code: "Enter", ctrlKey: true, repeat: true }), "Mod+Enter")).toBe(true);
  expect(matchCombination(key({ code: "Enter", ctrlKey: true }), "Mod+Enter")).toBe(true);
  expect(matchCombination(key({ code: "Enter", metaKey: true, repeat: true }), "Mod+Enter")).toBe(false);
});

test("a held combination acts once, but its repeats stay the shortcut's (prevented and stopped)", () => {
  platform("Linux x86_64");
  const child = document.createElement("div");
  document.body.appendChild(child);
  const childKey = vi.fn();
  child.addEventListener("keydown", childKey);
  const handler = vi.fn();
  renderHook(() => useShortcut("Alt+1", handler, { capture: true, stopPropagation: true, skipInEditable: true }));
  const fire = (target: Element, init: KeyboardEventInit = {}) => {
    const e = key({ code: "Digit1", key: "1", altKey: true, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  fire(child);
  const repeats = [fire(child, { repeat: true }), fire(child, { repeat: true })];
  expect(handler).toHaveBeenCalledTimes(1);
  expect(repeats.every((e) => e.defaultPrevented)).toBe(true);
  expect(childKey).not.toHaveBeenCalled();
  // A repeat in a field or under a modal is not ours: left alone.
  const input = document.createElement("input");
  document.body.appendChild(input);
  expect(fire(input, { repeat: true }).defaultPrevented).toBe(false);
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.appendChild(modal);
  expect(fire(child, { repeat: true }).defaultPrevented).toBe(false);
  expect(handler).toHaveBeenCalledTimes(1);
});

test("without stopPropagation a repeat is still prevented (no default action), not run", () => {
  platform("Linux x86_64");
  const handler = vi.fn();
  renderHook(() => useShortcut("Mod+T", handler));
  const e = key({ code: "KeyT", ctrlKey: true, repeat: true, cancelable: true });
  window.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(true);
  expect(handler).not.toHaveBeenCalled();
});

test("typesCharacter: text, not shortcuts; AltGr symbols are text (#102)", () => {
  const ev = (init: KeyboardEventInit & { altGraph?: boolean }) => {
    const { altGraph = false, ...rest } = init;
    const e = key(rest);
    Object.defineProperty(e, "getModifierState", { value: (k: string) => k === "AltGraph" && altGraph });
    return e;
  };
  const linux = false;
  expect(typesCharacter(ev({ key: "f", code: "KeyF" }), linux)).toBe(true);
  expect(typesCharacter(ev({ key: "F", code: "KeyF", shiftKey: true }), linux)).toBe(true);
  expect(typesCharacter(ev({ key: " ", code: "Space" }), linux)).toBe(true);
  expect(typesCharacter(ev({ key: "Enter", code: "Enter" }), linux)).toBe(false);
  expect(typesCharacter(ev({ key: "Dead", code: "BracketLeft" }), linux)).toBe(false);
  // Ctrl, Super (Meta) and Alt alone are shortcuts.
  expect(typesCharacter(ev({ key: "f", code: "KeyF", ctrlKey: true }), linux)).toBe(false);
  expect(typesCharacter(ev({ key: "f", code: "KeyF", metaKey: true }), linux)).toBe(false);
  expect(typesCharacter(ev({ key: "f", code: "KeyF", altKey: true }), linux)).toBe(false);
  expect(typesCharacter(ev({ key: "&", code: "Digit1", altKey: true }), linux)).toBe(false);
  // Ctrl+Alt+F: plain, or reported as AltGr, it is no text.
  expect(typesCharacter(ev({ key: "f", code: "KeyF", ctrlKey: true, altKey: true }), linux)).toBe(false);
  expect(typesCharacter(ev({ key: "f", code: "KeyF", altGraph: true }), linux)).toBe(false);
  expect(typesCharacter(ev({ key: "f", code: "KeyF", ctrlKey: true, altKey: true, altGraph: true }), linux)).toBe(false);
  // Ctrl+Alt+[ on a US layout is no text; AltGr symbols are (Linux: AltGraph alone;
  // Windows: Ctrl + Alt + AltGraph; without AltGraph only a non-ASCII character).
  expect(typesCharacter(ev({ key: "[", code: "BracketLeft", ctrlKey: true, altKey: true }), linux)).toBe(false);
  expect(typesCharacter(ev({ key: "€", code: "KeyE", altGraph: true }), linux)).toBe(true);
  expect(typesCharacter(ev({ key: "@", code: "Digit0", ctrlKey: true, altKey: true, altGraph: true }), linux)).toBe(true);
  expect(typesCharacter(ev({ key: "€", code: "KeyE", ctrlKey: true, altKey: true }), linux)).toBe(true);
  // macOS: Option types characters, Ctrl and Cmd never do.
  expect(typesCharacter(ev({ key: "ƒ", code: "KeyF", altKey: true }), true)).toBe(true);
  expect(typesCharacter(ev({ key: "{", code: "Digit5", altKey: true }), true)).toBe(true);
  expect(typesCharacter(ev({ key: "f", code: "KeyF", ctrlKey: true }), true)).toBe(false);
  expect(typesCharacter(ev({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }), true)).toBe(false);
});

// #105: every layout of src/test/layouts.ts (xkeyboard-config values), pressed with every
// key and every chord the defaults use.

/** The default combinations off macOS (each action's default and alternates). */
const DEFAULT_SPECS = [
  ...new Set((Object.keys(DEFAULT_KEYMAP) as KeymapActionId[]).flatMap((id) => effectiveShortcuts(id, {}, false))),
];
const LAYOUT_NAMES = Object.keys(LAYOUTS) as LayoutName[];

/** Types `layout`'s letter at KeyA, as a user does: the tracker learns the layout's script (#131). */
function typeLetterOf(layout: LayoutName): void {
  installLayoutTracker();
  window.dispatchEvent(key({ code: "KeyA", key: LAYOUTS[layout].KeyA[0] }));
}

/** The layouts whose letters are not Latin: punctuation by US position there (#131). */
const NON_LATIN: readonly LayoutName[] = ["il", "gr", "ru"];

/** The presses of `layout` that match `spec`, as "Ctrl+Shift+Digit7 (/)", sorted, after a letter typed. */
function whereIs(layout: LayoutName, spec: string): string[] {
  typeLetterOf(layout);
  return presses(layout)
    .filter((p) => matchCombination(key(p), spec))
    .map(describePress)
    .sort();
}

test("typing a letter tells a non-Latin layout from a Latin one (#131)", () => {
  for (const layout of LAYOUT_NAMES) {
    typeLetterOf(layout);
    expect(nonLatinLayout(), layout).toBe(NON_LATIN.includes(layout));
  }
});

test("every default combination has a key on every layout (#105, #131)", () => {
  platform("Linux x86_64");
  for (const layout of LAYOUT_NAMES) {
    for (const spec of DEFAULT_SPECS) expect(whereIs(layout, spec), `${layout} ${spec}`).not.toEqual([]);
  }
});

/** The presses of `layout` that match `spec`, in the tracker's current state (no letter typed). */
function whereIsNow(layout: LayoutName, spec: string): string[] {
  return presses(layout)
    .filter((p) => matchCombination(key(p), spec))
    .map(describePress)
    .sort();
}

test("every default combination has a key on every layout at startup, no letter typed yet (#131)", () => {
  platform("Linux x86_64");
  // The startup state is Latin, and stays so right after a switch from a Latin layout: a
  // non-Latin layout must still reach every default then (Hebrew's W key types "'").
  expect(nonLatinLayout()).toBe(false);
  for (const layout of LAYOUT_NAMES) {
    for (const spec of DEFAULT_SPECS) expect(whereIsNow(layout, spec), `${layout} ${spec}`).not.toEqual([]);
  }
  expect(whereIsNow("il", "Mod+W")).toEqual(["Ctrl+KeyW (')"]);
});

/** Runs `check` for every layout with the tracker in both states (a stale state included, #131). */
function eachLayoutAndState(check: (layout: LayoutName, state: string) => void): void {
  for (const nonLatin of [false, true]) {
    __setNonLatinLayoutForTests(nonLatin);
    for (const layout of LAYOUT_NAMES) check(layout, nonLatin ? "non-Latin" : "Latin");
  }
  __setNonLatinLayoutForTests(false);
}

test("a key press matches one combination at most, on every layout (#105, #131)", () => {
  platform("Linux x86_64");
  eachLayoutAndState((layout, state) => {
    for (const p of presses(layout)) {
      const matched = DEFAULT_SPECS.filter((spec) => matchCombination(key(p), spec));
      expect(matched.length, `${layout} ${state} ${describePress(p)}: ${matched.join(", ")}`).toBeLessThanOrEqual(1);
    }
  });
});

test("no Ctrl+Alt press (AltGr on Windows) matches a default off macOS (#102, #105, #131)", () => {
  platform("Linux x86_64");
  eachLayoutAndState((layout, state) => {
    for (const p of presses(layout).filter((q) => q.ctrlKey && q.altKey)) {
      const matched = DEFAULT_SPECS.filter((spec) => matchCombination(key(p), spec));
      expect(matched, `${layout} ${state} ${describePress(p)}`).toEqual([]);
    }
  });
  // AltGr on Linux (no Ctrl, no Alt) gives a plain character: no shortcut.
  expect(DEFAULT_SPECS.some((spec) => matchCombination(key({ code: "Digit5", key: "[" }), spec))).toBe(false);
  // Ctrl+AltGr on Linux reports Ctrl alone with the AltGr character. On AZERTY's digit row
  // the key stays its digit: Ctrl+AltGr+5 ("[") is Ctrl+5, tab 5, not Ctrl+[.
  const digit = key({ code: "Digit5", key: "[", ctrlKey: true });
  expect(matchCombination(digit, "Mod+5")).toBe(true);
  expect(matchCombination(digit, "Mod+[")).toBe(false);
  // Off the digit row the AltGr character counts: Ctrl+AltGr+")" ("]") is Ctrl+], next tab
  // (before #105 it was Ctrl+-, font smaller, by position).
  const minus = key({ code: "Minus", key: "]", ctrlKey: true });
  expect(matchCombination(minus, "Mod+]")).toBe(true);
  expect(matchCombination(minus, "Mod+-")).toBe(false);
});

test("the recorder names every press as the matching reads it, on every layout (#105, #131)", () => {
  platform("Linux x86_64");
  eachLayoutAndState((layout, state) => {
    for (const p of presses(layout)) {
      const { key: k, shift } = keyPressOf(key(p));
      const spec = [p.ctrlKey && "Mod", p.altKey && "Alt", shift && "Shift", k].filter(Boolean).join("+");
      if (k === "" || !isValidShortcut(spec)) continue;
      expect(matchCombination(key(p), spec), `${layout} ${state} ${describePress(p)} as ${spec}`).toBe(true);
    }
  });
});

test("punctuation follows the character the layout types; positions fill in (#105)", () => {
  platform("Linux x86_64");
  // US: every key where it always was.
  expect(whereIs("us", "Mod+,")).toEqual(["Ctrl+Comma (,)"]);
  expect(whereIs("us", "Mod+/")).toEqual(["Ctrl+Slash (/)"]);
  expect(whereIs("us", "Mod+Shift+[")).toEqual(["Ctrl+Shift+BracketLeft ({)"]);
  expect(whereIs("us", "Mod+Shift+=")).toEqual(["Ctrl+Shift+Equal (+)"]);
  // AZERTY: "," is the key labelled ","; ";" is its own; "/" is the "!" key by position or
  // Shift+":" (Shift belongs to the character); "-" stays tab 6 on the digit row, and Ctrl+-
  // is the ")" key by position (and the keypad's −).
  expect(whereIs("fr", "Mod+,")).toEqual(["Ctrl+KeyM (,)"]);
  expect(whereIs("fr", "Mod+;")).toEqual(["Ctrl+Comma (;)"]);
  expect(whereIs("fr", "Mod+/")).toEqual(["Ctrl+Shift+Period (/)", "Ctrl+Slash (!)"]);
  expect(whereIs("fr", "Mod+6")).toEqual(["Ctrl+Digit6 (-)"]);
  expect(whereIs("fr", "Mod+-")).toEqual(["Ctrl+Minus ())"]);
  expect(whereIs("fr", "Mod+NumpadSubtract")).toEqual(["Ctrl+NumpadSubtract (-)"]);
  expect(whereIs("fr", "Mod+=")).toEqual(["Ctrl+Equal (=)"]);
  expect(whereIs("fr", "Mod+Shift+=")).toEqual(["Ctrl+Shift+Equal (+)"]);
  expect(whereIs("fr", "Mod+[")).toEqual(["Ctrl+BracketLeft (Dead)"]);
  expect(whereIs("fr", "Mod+]")).toEqual(["Ctrl+BracketRight ($)"]);
  expect(whereIs("fr", "Mod+W")).toEqual(["Ctrl+KeyZ (w)"]);
  // QWERTZ: "-" is the "-" key ("ß" keeps it by position); "/" and "=" are Shift+7 / Shift+0.
  expect(whereIs("de", "Mod+-")).toEqual(["Ctrl+Minus (ß)", "Ctrl+Slash (-)"]);
  expect(whereIs("de", "Mod+/")).toEqual(["Ctrl+Shift+Digit7 (/)"]);
  expect(whereIs("de", "Mod+=")).toEqual(["Ctrl+Equal (Dead)", "Ctrl+Shift+Digit0 (=)"]);
  expect(whereIs("de", "Mod+]")).toEqual(["Ctrl+BracketRight (+)"]);
  expect(whereIs("de", "Mod+Z")).toEqual(["Ctrl+KeyY (z)"]);
  // Dvorak: every punctuation where Dvorak types it, Shift chords included.
  expect(whereIs("dvorak", "Mod+,")).toEqual(["Ctrl+KeyW (,)"]);
  expect(whereIs("dvorak", "Mod+/")).toEqual(["Ctrl+BracketLeft (/)"]);
  expect(whereIs("dvorak", "Mod+[")).toEqual(["Ctrl+Minus ([)"]);
  expect(whereIs("dvorak", "Mod+]")).toEqual(["Ctrl+Equal (])"]);
  expect(whereIs("dvorak", "Mod+Shift+[")).toEqual(["Ctrl+Shift+Minus ({)"]);
  expect(whereIs("dvorak", "Mod+=")).toEqual(["Ctrl+BracketRight (=)"]);
  expect(whereIs("dvorak", "Mod+Shift+=")).toEqual(["Ctrl+Shift+BracketRight (+)"]);
  expect(whereIs("dvorak", "Mod+-")).toEqual(["Ctrl+Quote (-)"]);
  expect(whereIs("dvorak", "Mod+W")).toEqual(["Ctrl+Comma (w)"]);
  // Dvorak's "'" key (KeyQ) names no shortcut: Q by position, besides Dvorak's Q (KeyX). Kept
  // so that Hebrew's "'" key is W before a Hebrew letter is typed (#131).
  expect(whereIs("dvorak", "Mod+Q")).toEqual(["Ctrl+KeyQ (')", "Ctrl+KeyX (q)"]);
  // Non-Latin layouts (after a letter typed, #131): letters and punctuation by US position,
  // as browsers and GTK apps do; the keycaps carry the US legends.
  // Hebrew: "/" on the Slash key (not Q, which types "/"), brackets not swapped.
  expect(whereIs("il", "Mod+W")).toEqual(["Ctrl+KeyW (')"]);
  expect(whereIs("il", "Mod+Q")).toEqual(["Ctrl+KeyQ (/)"]);
  expect(whereIs("il", "Mod+/")).toEqual(["Ctrl+Slash (.)"]);
  expect(whereIs("il", "Mod+,")).toEqual(["Ctrl+Comma (ת)"]);
  expect(whereIs("il", "Mod+[")).toEqual(["Ctrl+BracketLeft (])"]);
  expect(whereIs("il", "Mod+]")).toEqual(["Ctrl+BracketRight ([)"]);
  expect(whereIs("il", "Mod+Shift+[")).toEqual(["Ctrl+Shift+BracketLeft (})"]);
  expect(whereIs("il", "Mod+T")).toEqual(["Ctrl+KeyT (א)"]);
  // Greek: as US; its Q key (";") is Q.
  expect(whereIs("gr", "Mod+W")).toEqual(["Ctrl+KeyW (ς)"]);
  expect(whereIs("gr", "Mod+/")).toEqual(["Ctrl+Slash (/)"]);
  expect(whereIs("gr", "Mod+Q")).toEqual(["Ctrl+KeyQ (;)"]);
  expect(whereIs("gr", "Mod+;")).toEqual(["Ctrl+Semicolon (Dead)"]);
  // Russian: "/" on the Slash key (it types "."), "," on the Comma key, Shift+\ is Shift+\.
  expect(whereIs("ru", "Mod+W")).toEqual(["Ctrl+KeyW (ц)"]);
  expect(whereIs("ru", "Mod+/")).toEqual(["Ctrl+Slash (.)"]);
  expect(whereIs("ru", "Mod+.")).toEqual(["Ctrl+Period (ю)"]);
  expect(whereIs("ru", "Mod+,")).toEqual(["Ctrl+Comma (б)"]);
  expect(whereIs("ru", "Mod+[")).toEqual(["Ctrl+BracketLeft (х)"]);
  expect(whereIs("ru", "Mod+]")).toEqual(["Ctrl+BracketRight (ъ)"]);
  expect(whereIs("ru", "Mod+Shift+\\")).toEqual(["Ctrl+Shift+Backslash (/)"]);
});

test("the tracker learns the script from plain letter presses only (#131)", () => {
  installLayoutTracker();
  const press = (init: KeyboardEventInit & { altGraph?: boolean }) => {
    const { altGraph = false, ...rest } = init;
    const e = key(rest);
    Object.defineProperty(e, "getModifierState", { value: (k: string) => k === "AltGraph" && altGraph });
    window.dispatchEvent(e);
    return nonLatinLayout();
  };
  expect(nonLatinLayout()).toBe(false);
  expect(press({ code: "KeyA", key: "ф" })).toBe(true);
  expect(press({ code: "KeyA", key: "a" })).toBe(false);
  // Ctrl+letter keeps the layout's letter (GTK): it counts.
  expect(press({ code: "KeyW", key: "ц", ctrlKey: true })).toBe(true);
  expect(press({ code: "KeyW", key: "z", ctrlKey: true })).toBe(false);
  // Shift (Hebrew's Shift level types Latin capitals), Alt, AltGr and Meta do not count.
  __setNonLatinLayoutForTests(true);
  expect(press({ code: "KeyA", key: "A", shiftKey: true })).toBe(true);
  expect(press({ code: "KeyA", key: "a", altKey: true })).toBe(true);
  expect(press({ code: "KeyA", key: "a", altGraph: true })).toBe(true);
  expect(press({ code: "KeyA", key: "a", metaKey: true })).toBe(true);
  // Only the letter positions, and only a letter typed there.
  expect(press({ code: "Semicolon", key: "m" })).toBe(true);
  expect(press({ code: "Digit2", key: "é" })).toBe(true);
  expect(press({ code: "KeyQ", key: "'" })).toBe(true);
  expect(press({ code: "KeyM", key: "," })).toBe(true);
  expect(press({ code: "BracketLeft", key: "Dead" })).toBe(true);
  expect(press({ code: "KeyE", key: "Dead" })).toBe(true);
  // Latin beyond ASCII is Latin (Turkish "ı", German "ß"); Greek, Hebrew, Cyrillic are not.
  expect(press({ code: "KeyI", key: "ı" })).toBe(false);
  expect(press({ code: "KeyT", key: "τ" })).toBe(true);
  expect(press({ code: "KeyE", key: "ß" })).toBe(false);
  expect(press({ code: "KeyT", key: "א" })).toBe(true);
});

test("the tracker is installed once", () => {
  installLayoutTracker();
  const add = vi.spyOn(window, "addEventListener");
  installLayoutTracker();
  expect(add).not.toHaveBeenCalled();
});

test("a letter typed switches punctuation between typed character and US position (#131)", () => {
  platform("Linux x86_64");
  const handler = vi.fn();
  renderHook(() => useShortcut("Mod+/", handler));
  const slash = () => window.dispatchEvent(key({ code: "Slash", key: ".", ctrlKey: true, cancelable: true }));
  // Russian Slash key types "." : read as Ctrl+. until a Russian letter is typed.
  slash();
  expect(handler).not.toHaveBeenCalled();
  window.dispatchEvent(key({ code: "KeyF", key: "а" }));
  slash();
  expect(handler).toHaveBeenCalledTimes(1);
  // Back to a Latin layout: a Latin letter typed, the typed character counts again.
  window.dispatchEvent(key({ code: "KeyF", key: "f" }));
  slash();
  expect(handler).toHaveBeenCalledTimes(1);
});

test("a shortcut character typed with Shift keeps Shift for itself (#105)", () => {
  platform("Linux x86_64");
  const slash = key({ code: "Digit7", key: "/", ctrlKey: true, shiftKey: true }); // QWERTZ
  expect(keyPressOf(slash)).toEqual({ key: "/", shift: false });
  expect(matchCombination(slash, "Mod+/")).toBe(true);
  expect(matchCombination(slash, "Mod+Shift+/")).toBe(false);
  expect(matchCombination(slash, "Mod+Shift+7")).toBe(false);
  // A US shifted symbol is Shift + its key's character ("{" is Shift+[).
  expect(keyPressOf(key({ code: "Minus", key: "{", shiftKey: true }))).toEqual({ key: "[", shift: true });
  // Not on the digit row: there it is the digit (Russian Shift+7 types "?").
  expect(keyPressOf(key({ code: "Digit7", key: "?", shiftKey: true }))).toEqual({ key: "7", shift: true });
  // macOS: ⌘⇧[ reports "{".
  platform("MacIntel");
  expect(matchCombination(key({ code: "BracketLeft", key: "{", metaKey: true, shiftKey: true }), "Mod+Shift+[")).toBe(true);
});

test("the keypad's Enter is Enter (#122)", () => {
  platform("Linux x86_64");
  const e = key({ code: "NumpadEnter", key: "Enter", ctrlKey: true });
  expect(matchCombination(e, "Mod+Enter")).toBe(true);
  expect(matchCombination(key({ code: "NumpadEnter", key: "Enter", ctrlKey: true, shiftKey: true }), "Mod+Shift+Enter")).toBe(true);
  // The keypad's other keys keep no name: Ctrl + keypad "/" is no comment.
  expect(matchCombination(key({ code: "NumpadDivide", key: "/", ctrlKey: true }), "Mod+/")).toBe(false);
});
