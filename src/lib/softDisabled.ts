import type { MouseEvent } from "react";

/**
 * Props of a button that is off but keeps its tooltip (#110): `aria-disabled` instead of
 * native `disabled`. WebKitGTK may send no hover or focus event to a native disabled
 * button, so the tooltip of `tip()` could never show. The button stays hoverable and
 * focusable (WAI-ARIA lets disabled toolbar items keep the focus), reads as unavailable,
 * and its click (a press, Enter or Space) does nothing: no handler, no form submit, no
 * bubbling, as a native disabled button. Style it with `aria-disabled:` variants next to
 * `disabled:`; the global cursor rule (`src/styles/interaction.css`) already shows the arrow.
 *
 * Limits: it guards `onClick` only.
 * - Spread it after any `onClick` of the element's own, or that one replaces the guard.
 * - An `onKeyDown`, `onMouseDown` or `onPointerDown` that activates the button is not
 *   guarded: give the button no such handler, or check `off` in it.
 * - Shortcuts bound to the same action must guard themselves: this covers the button only.
 */
export function softDisabled<E extends HTMLElement = HTMLButtonElement>(
  off: boolean,
  onClick?: (e: MouseEvent<E>) => void,
): { "aria-disabled"?: true; onClick: (e: MouseEvent<E>) => void } {
  return {
    "aria-disabled": off || undefined,
    onClick: (e) => {
      if (off) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClick?.(e);
    },
  };
}

/** Is the control off, natively (`disabled`) or by `aria-disabled="true"`? */
export function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}
