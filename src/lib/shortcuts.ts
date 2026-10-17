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
};

function codeFor(key: string): string {
  const k = key.toLowerCase();
  if (NAMED_CODES[k]) return NAMED_CODES[k];
  if (/^[a-z]$/.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  return key; // e.g. "F5", "Backspace": already a KeyboardEvent.code
}

/**
 * Does `e` match `spec` (`"Mod+K"`, `"Ctrl+Tab"`, `"Mod+Shift+F"`)? `Mod` is Meta on
 * macOS and Ctrl elsewhere; `Ctrl` is always Ctrl. The key is compared with `e.code`
 * (layout independent) and the modifiers must match exactly. Auto-repeat never matches.
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
    e.code === codeFor(key) &&
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
 * Registers a window `keydown` shortcut for the lifetime of the component. A matching
 * event is `preventDefault`ed (and stopped with `stopPropagation`) before `handler` runs.
 * Skipped on auto-repeat, while a modal is open (unless `allowInModal`) and, with
 * `skipInEditable`, in a field.
 */
export function useShortcut(
  spec: string,
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
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!matchShortcut(e, spec)) return;
      if (skipInEditable && isEditableTarget(e.target)) return;
      if (!allowInModal && isModalOpen()) return;
      e.preventDefault();
      if (stopPropagation) e.stopPropagation();
      handlerRef.current(e);
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [spec, allowInModal, capture, stopPropagation, skipInEditable, enabled]);
}
