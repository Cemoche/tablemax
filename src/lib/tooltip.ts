/**
 * Tooltips (#109): a control declares its hint with `{...tip(label, shortcut)}` and the one
 * `TooltipLayer` mounted by the app shows it (timing, motion, placement, Escape). No native
 * `title`: the OS tooltip is slow, unstyled and cannot show a key.
 *
 * `shortcut` is a display text from the live keymap (`formatShortcut(effectiveShortcut…)`),
 * shown as a key next to the label. The hint is a description: a control keeps its own
 * `aria-label` (or text) as its name.
 */
export const TIP_ATTR = "data-tooltip";
export const TIP_KEY_ATTR = "data-tooltip-key";
/** Show only when the element (or its text inside) is actually cut. */
export const TIP_OVERFLOW_ATTR = "data-tooltip-overflow";

export interface TipProps {
  "data-tooltip"?: string;
  "data-tooltip-key"?: string;
  "data-tooltip-overflow"?: string;
}

/** The props that give an element a tooltip; nothing for an empty label. */
export function tip(label: string | null | undefined, shortcut?: string | null): TipProps {
  if (!label) return {};
  return shortcut ? { [TIP_ATTR]: label, [TIP_KEY_ATTR]: shortcut } : { [TIP_ATTR]: label };
}

/**
 * The tooltip of a name that may be cut (ellipsis or line clamp): it shows only while the
 * text does not fit, to read it whole.
 */
export function tipIfCut(label: string | null | undefined): TipProps {
  if (!label) return {};
  return { [TIP_ATTR]: label, [TIP_OVERFLOW_ATTR]: "" };
}
