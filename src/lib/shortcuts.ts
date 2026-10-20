import { useEffect, useRef } from "react";
import { isMac } from "./platform";

/** True while a modal dialog (any element with `aria-modal="true"`) is open. */
export function isModalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

const NAMED_CODES: Record<string, string> = {
  tab: "Tab",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  "/": "Slash",
  ".": "Period",
  ",": "Comma",
  ";": "Semicolon",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "`": "Backquote",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function codeFor(key: string): string {
  const k = key.toLowerCase();
  if (NAMED_CODES[k]) return NAMED_CODES[k];
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  return key; // e.g. "F5", "Backspace": already a KeyboardEvent.code
}

const LATIN_LETTER = /^[a-z]$/i;
/** One printable ASCII character (a letter, digit, space or punctuation). */
const ASCII_PRINTABLE = /^[\x20-\x7e]$/;

/**
 * The letter a keydown stands for in a shortcut, uppercase, or null when it is no letter.
 * Letters follow the layout: `e.key` when it is a Latin letter (AZERTY's Z key is "Z",
 * whatever its position), else the physical key (`e.code`) when `e.key` is not ASCII
 * (Cyrillic, Greek, an Option character on macOS, a dead key), so letter shortcuts still
 * work on non-Latin layouts. A letter position that types ASCII punctuation (AZERTY's M
 * position types ",") is no letter.
 */
function eventLetter(e: Pick<KeyboardEvent, "key" | "code">): string | null {
  const key = e.key ?? "";
  if (LATIN_LETTER.test(key)) return key.toUpperCase();
  const m = /^Key([A-Z])$/.exec(e.code ?? "");
  return m && !ASCII_PRINTABLE.test(key) ? m[1] : null;
}

/** Does the key of `e` (modifiers aside) match the key part of a spec? */
function keyMatches(e: KeyboardEvent, key: string): boolean {
  if (LATIN_LETTER.test(key)) return eventLetter(e) === key.toUpperCase();
  // Digits, punctuation and named keys by position (AZERTY digits need Shift), but never a
  // key that types a letter: that key is its letter's.
  return e.code === codeFor(key) && !LATIN_LETTER.test(e.key ?? "");
}

const CODE_KEYS: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
};
const NAMED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown",
]);

/**
 * The key part of the canonical spec for a keydown (`"W"`, `"1"`, `"/"`, `"Enter"`, `"F5"`),
 * by the same rules as the matching: whatever it returns, `matchCombination` matches. Empty
 * when the grammar has no name for the key (the Settings recorder reports it as invalid).
 */
export function shortcutKeyOf(e: Pick<KeyboardEvent, "key" | "code">): string {
  const letter = eventLetter(e);
  if (letter) return letter;
  if (LATIN_LETTER.test(e.key ?? "")) return "";
  const code = e.code ?? "";
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code) || NAMED_KEYS.has(code)) return code;
  return Object.prototype.hasOwnProperty.call(CODE_KEYS, code) ? CODE_KEYS[code] : "";
}

/**
 * Does `e` match `spec` (`"Mod+K"`, `"Ctrl+Tab"`, `"Mod+Shift+F"`)? `Mod` is Meta on
 * macOS and Ctrl elsewhere; `Ctrl` is always Ctrl. A letter follows the layout (`e.key`,
 * with `e.code` for non-Latin layouts: see `eventLetter`); digits, punctuation and named
 * keys are compared with `e.code` (layout independent). The modifiers must match exactly.
 * Auto-repeat never matches.
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
  return (
    keyMatches(e, key) &&
    e.ctrlKey === ctrl &&
    e.metaKey === meta &&
    e.shiftKey === shift &&
    e.altKey === alt
  );
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
  const key = typeof spec === "string" ? spec : spec.join("\n");
  useEffect(() => {
    if (!enabled) return;
    const specs = key.split("\n");
    const onKey = (e: KeyboardEvent) => {
      if (!specs.some((s) => matchCombination(e, s))) return;
      if (skipInEditable && isEditableTarget(e.target)) return;
      if (!allowInModal && isModalOpen()) return;
      e.preventDefault();
      if (stopPropagation) e.stopPropagation();
      if (e.repeat) return;
      handlerRef.current(e);
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [key, allowInModal, capture, stopPropagation, skipInEditable, enabled]);
}
