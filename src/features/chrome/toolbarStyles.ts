/** Shared looks of the toolbar (spec §5.2: toolbar 52 px, pill groups 34 px, buttons 28–32 px). */

/** Thin monochrome icons (lucide), the size of the mockup's. */
export const ICON = { size: 17, strokeWidth: 1.6 } as const;

/** A rounded group of buttons. */
export const pillGroup =
  "flex h-8.5 shrink-0 items-center rounded-full border border-pill-border bg-pill px-0.75";

/**
 * An icon button inside a pill group without its colour, for a coloured variant
 * (`text-danger-text`): Tailwind orders `.text-icon` after `.text-danger-text` (#129).
 */
export const iconButtonBase =
  "flex h-7 w-8 items-center justify-center rounded-full outline-none hover:bg-seg-sel aria-pressed:bg-seg-sel aria-expanded:bg-seg-sel disabled:text-icon-dim disabled:hover:bg-transparent aria-disabled:text-icon-dim aria-disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** An icon button inside a pill group: 32 × 28, dimmed when disabled (or aria-disabled), visible focus ring. */
export const iconButton = `${iconButtonBase} text-icon`;
