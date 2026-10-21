import { useEffect, useRef } from "react";
import { isMac } from "./platform";

/**
 * True while a modal dialog (an element with `aria-modal="true"`) is open on screen: one
 * inside a `hidden` subtree (the connection form kept behind a workspace) does not count.
 */
export function isModalOpen(): boolean {
  return [...document.querySelectorAll('[aria-modal="true"]')].some((el) => el.closest("[hidden]") === null);
}

const LATIN_LETTER = /^[a-z]$/i;
/** One printable ASCII character (a letter, digit, space or punctuation). */
const ASCII_PRINTABLE = /^[\x20-\x7e]$/;
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;
const DIGIT_ROW = /^Digit[0-9]$/;
const LETTER_POSITION = /^Key([A-Z])$/;

/** The shortcut characters besides letters and digits (the grammar's, `isValidShortcut`). */
const PUNCTUATION = new Set([",", ".", "/", ";", "-", "=", "[", "]", "\\", "`"]);

/** The punctuation positions: the character a US layout types there. */
const POSITION_CHARS = new Map([
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
  ["Semicolon", ";"],
  ["Minus", "-"],
  ["Equal", "="],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Backslash", "\\"],
  ["Backquote", "`"],
]);

/** The US layout's Shift level: the shifted symbol of each punctuation character ("{" is Shift+[). */
const US_SHIFTED = new Map([
  ["<", ","],
  [">", "."],
  ["?", "/"],
  [":", ";"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  ["~", "`"],
]);

/** Keys named by their position (`e.code`), whatever they type. */
const NAMED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "NumpadAdd", "NumpadSubtract",
]);

/** The spellings `matchCombination` accepts for a named key (lowercase) besides the canonical one. */
const NAMED_ALIASES = new Map([...NAMED_KEYS].map((k) => [k.toLowerCase(), k] as [string, string]).concat([["esc", "Escape"]]));

/** A letter of any script, and a letter of the Latin script ("ı", "ß" and "é" are Latin). */
const ANY_LETTER = /^\p{L}$/u;
const LATIN_SCRIPT = /^\p{Script=Latin}$/u;

/** Is the active layout non-Latin (Russian, Hebrew, Greek…)? Learnt from the letters typed (#131). */
let nonLatin = false;
let trackerInstalled = false;

/** True when the last letter typed was not Latin: punctuation shortcuts go by US position (#131). */
export function nonLatinLayout(): boolean {
  return nonLatin;
}

/** Tests only: sets the tracker's state (the test setup resets it to Latin after each test). */
export function __setNonLatinLayoutForTests(value: boolean): void {
  nonLatin = value;
}

/**
 * Learns the active layout's script from a keydown: a press of a letter position
 * (`KeyA`–`KeyZ`) with neither Shift (Hebrew's Shift level types Latin capitals) nor Alt,
 * AltGr or Meta (their levels vary) that types a letter. Ctrl counts: GTK keeps the
 * layout's letter in `e.key` under Ctrl. Anything else leaves the state as it was.
 */
function noteLayoutScript(e: KeyboardEvent): void {
  if (!LETTER_POSITION.test(e.code ?? "") || e.shiftKey || e.altKey || e.metaKey) return;
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return;
  const ch = e.key ?? "";
  if (ANY_LETTER.test(ch)) nonLatin = !LATIN_SCRIPT.test(ch);
}

/**
 * Installs (once) the window listener that learns the layout's script, in the capture phase:
 * it runs before every shortcut listener and the recorder, so a press reads the state it
 * has just set (Ctrl+ц on a Russian layout is read as Russian). The webview cannot ask the
 * system which layout is active; right after a layout switch the state is the previous
 * layout's until a letter is typed.
 */
export function installLayoutTracker(): void {
  if (trackerInstalled || typeof window === "undefined") return;
  trackerInstalled = true;
  window.addEventListener("keydown", noteLayoutScript, true);
}

/**
 * A keydown as a shortcut reads it: its key's name in the grammar (`"W"`, `"1"`, `"/"`,
 * `"Enter"`, `"F5"`; `""` when the grammar has none) and whether Shift counts as a modifier.
 */
export interface KeyPress {
  key: string;
  shift: boolean;
}

/**
 * Names a keydown for the shortcuts (spec §5.3, amendments #102, #105 and #131): on a Latin
 * layout a key is the character the layout types on it when that character can name a
 * shortcut, else its position; on a non-Latin layout (`nonLatinLayout`) letters and
 * punctuation go by US position, as in browsers and GTK apps. In order:
 * 1. Named keys (Enter, Tab, arrows, F1–F12, the keypad's + and −…) by position; the
 *    keypad's Enter is Enter (#122); the keypad's other keys have no name.
 * 2. A Latin letter typed (`e.key`) is that letter, wherever the key sits (AZERTY's Z key is
 *    Z, Dvorak's are Dvorak's).
 * 3. Latin layout only: a shortcut punctuation character typed (`, . / ; - = [ ] \ \``) is
 *    that character: AZERTY's "," key is Ctrl+, and Dvorak's "/" key Ctrl+/. When Shift
 *    typed it (QWERTZ Shift+7 = "/"), Shift belongs to the character, not to the shortcut.
 *    On the digit row a character typed without Shift does not count: the row stays digits
 *    (AZERTY's "-" key is Ctrl+6, tab 6, as in browsers).
 * 4. Latin layout only: with Shift, a US shifted symbol (`< > ? : _ + { } | ~`) is Shift +
 *    its US key's character ("{" is Shift+[), off the digit row.
 * 5. Else the position (`e.code`): the digit row's digit, a letter position's letter (a
 *    non-Latin letter, a dead key; on a non-Latin layout anything: Hebrew's "/" key is Q),
 *    a punctuation position's US character (AZERTY's "!" key is "/", its ")" key "-";
 *    Russian's "." key is "/"). On a Latin layout a letter position typing ASCII that names
 *    no shortcut has no name (Dvorak's "'" key is no Ctrl+Q: Q is elsewhere).
 * No layout table: `keyCode` says nothing more on Linux (WebKitGTK derives it from the
 * typed character), and the webview cannot tell which layout is active; the layout's
 * script comes from the last letter typed (`installLayoutTracker`).
 */
export function keyPressOf(e: Pick<KeyboardEvent, "key" | "code" | "shiftKey">): KeyPress {
  const code = e.code ?? "";
  const shift = e.shiftKey === true;
  if (code === "NumpadEnter") return { key: "Enter", shift };
  if (NAMED_KEYS.has(code) || FUNCTION_KEY.test(code)) return { key: code, shift };
  if (code.startsWith("Numpad")) return { key: "", shift };
  const ch = e.key ?? "";
  if (LATIN_LETTER.test(ch)) return { key: ch.toUpperCase(), shift };
  const digitRow = DIGIT_ROW.test(code);
  if (!nonLatin) {
    if (PUNCTUATION.has(ch) && (shift || !digitRow)) return { key: ch, shift: false };
    const base = US_SHIFTED.get(ch);
    if (shift && !digitRow && base !== undefined) return { key: base, shift };
  }
  if (digitRow) return { key: code.slice(5), shift };
  const letter = LETTER_POSITION.exec(code);
  if (letter) return { key: !nonLatin && ASCII_PRINTABLE.test(ch) ? "" : letter[1], shift };
  return { key: POSITION_CHARS.get(code) ?? "", shift };
}

/** The key part of a spec in canonical form (a letter uppercase, "esc" → "Escape"). */
function specKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  return NAMED_ALIASES.get(key.toLowerCase()) ?? key;
}

/**
 * Does `e` match `spec` (`"Mod+K"`, `"Ctrl+Tab"`, `"Mod+Shift+F"`)? `Mod` is Meta on
 * macOS and Ctrl elsewhere; `Ctrl` is always Ctrl. The key is named by `keyPressOf`: the
 * character the layout types when it can name a shortcut, else the position (non-Latin
 * letters, AZERTY's digit row, named keys); on a non-Latin layout, the US position. The
 * modifiers must match exactly, Shift as `keyPressOf` counts it. Auto-repeat never matches.
 */
export function matchShortcut(e: KeyboardEvent, spec: string): boolean {
  return !e.repeat && matchCombination(e, spec);
}

/**
 * `matchShortcut` without the auto-repeat rule: are these the keys of `spec`? For a handler
 * that must swallow the repeats of its own combination (so a default binding of the same
 * keys does not act on them) without running the action again.
 */
export function matchCombination(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split("+");
  const key = parts.pop() as string;
  let ctrl = false;
  let meta = false;
  let shift = false;
  let alt = false;
  for (const m of parts) {
    switch (m.toLowerCase()) {
      case "mod":
        if (isMac()) meta = true;
        else ctrl = true;
        break;
      case "ctrl":
        ctrl = true;
        break;
      case "meta":
        meta = true;
        break;
      case "shift":
        shift = true;
        break;
      case "alt":
        alt = true;
        break;
    }
  }
  const press = keyPressOf(e);
  return (
    press.key !== "" &&
    press.key === specKey(key) &&
    e.ctrlKey === ctrl &&
    e.metaKey === meta &&
    press.shift === shift &&
    e.altKey === alt
  );
}

const ASCII_ALNUM = /^[a-z0-9]$/i;

/**
 * Does this keydown type a character the user means to type (into a grid cell, say)?
 * One printable character, and no shortcut modifier: never with Cmd / Super (Meta); with
 * Ctrl or Alt only as AltGr (third level: AltGr+E types "€" on AZERTY), which reports
 * AltGraph (Chromium on Windows with Ctrl and Alt down too). An AltGr chord that gives a
 * plain letter or digit is Ctrl+Alt+letter taken for AltGr (Linux, #102), not text.
 * On macOS Option types characters (Option+E is a dead key, Option+2 "™"); Ctrl never does.
 */
export function typesCharacter(e: KeyboardEvent, mac: boolean = isMac()): boolean {
  const ch = e.key ?? "";
  // One code point, not a control character ("Enter", "Dead", "\t" are no characters).
  if ([...ch].length !== 1 || /[\u0000-\u001f\u007f]/.test(ch)) return false;
  if (e.metaKey) return false;
  const altGraph = !mac && typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
  // AltGr levels type symbols, never a plain letter or digit: that is Ctrl+Alt+letter
  // reported as AltGr (with or without Ctrl / Alt down).
  if (altGraph) return !ASCII_ALNUM.test(ch);
  if (!e.ctrlKey && !e.altKey) return true;
  if (mac) return !e.ctrlKey && !ASCII_ALNUM.test(ch);
  // Ctrl+Alt without AltGraph: a character no plain key gives (not ASCII) is AltGr's.
  return e.ctrlKey && e.altKey && !ASCII_PRINTABLE.test(ch);
}

export interface ShortcutOptions {
  /** Fire even while a modal dialog is open (for a handler that manages modals itself). */
  allowInModal?: boolean;
  /** Listen in the capture phase, before the focused element's own handlers (the grid). */
  capture?: boolean;
  /** Stop a matching event there, so the focused element never sees it. */
  stopPropagation?: boolean;
  /** Ignore the keys typed in an input, textarea, select or contentEditable element. */
  skipInEditable?: boolean;
  /** Registers nothing while false (hooks cannot be called conditionally). Default true. */
  enabled?: boolean;
  /**
   * A matching event this returns true for is left alone (not prevented nor stopped): an
   * action of the focused region's scope takes those keys (`useAction`, spec §5.5 #90).
   */
  yieldTo?: (e: KeyboardEvent) => boolean;
}

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Is `target` a field the user types in? */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (EDITABLE.has(target.tagName) || target.isContentEditable);
}

/**
 * Registers a window `keydown` shortcut for the lifetime of the component (`spec` may list
 * several combinations of the same action). A matching
 * event is `preventDefault`ed (and stopped with `stopPropagation`) before `handler` runs.
 * Not while a modal is open (unless `allowInModal`) nor, with `skipInEditable`, in a field.
 * A held combination acts once: its auto-repeats are prevented (and stopped) like the
 * press, so they never reach the default action or the focused element, but `handler`
 * does not run again.
 */
export function useShortcut(
  spec: string | readonly string[],
  handler: (e: KeyboardEvent) => void,
  opts: ShortcutOptions = {},
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const {
    allowInModal = false,
    capture = false,
    stopPropagation = false,
    skipInEditable = false,
    enabled = true,
  } = opts;
  const yieldRef = useRef(opts.yieldTo);
  yieldRef.current = opts.yieldTo;
  const key = typeof spec === "string" ? spec : spec.join("\n");
  useEffect(() => {
    if (!enabled) return;
    installLayoutTracker(); // before this listener: a press is read with the state it sets
    const specs = key.split("\n");
    const onKey = (e: KeyboardEvent) => {
      if (!specs.some((s) => matchCombination(e, s))) return;
      if (skipInEditable && isEditableTarget(e.target)) return;
      if (!allowInModal && isModalOpen()) return;
      if (yieldRef.current?.(e)) return;
      e.preventDefault();
      if (stopPropagation) e.stopPropagation();
      if (e.repeat) return;
      handlerRef.current(e);
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [key, allowInModal, capture, stopPropagation, skipInEditable, enabled]);
}
