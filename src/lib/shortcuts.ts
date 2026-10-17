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
  if (e.repeat) return false;
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
}

/**
 * Registers a window `keydown` shortcut for the lifetime of the component. A matching
 * event is `preventDefault`ed before `handler` runs. Skipped on auto-repeat and while a
 * modal is open (unless `allowInModal`).
 */
export function useShortcut(
  spec: string,
  handler: (e: KeyboardEvent) => void,
  opts: ShortcutOptions = {},
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { allowInModal = false } = opts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchShortcut(e, spec)) return;
      if (!allowInModal && isModalOpen()) return;
      e.preventDefault();
      handlerRef.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spec, allowInModal]);
}
