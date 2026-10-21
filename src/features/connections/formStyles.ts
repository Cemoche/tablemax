// Class names of the compact connection form (spec §2.4 / §5.2): a 620 px form, a label
// column of 104 px aligned right, 28 px fields. The fit test of ConnectionForm.test.tsx
// reads the fixed heights (`h-*`) and the gap from these classes.

/** The form: 620 px wide, its parts 8 px apart. */
export const formClass = "mx-auto flex w-[620px] max-w-full flex-col gap-2 px-5 py-4";
/** One line of the form: the label column, then the field(s). */
export const rowClass = "grid h-7 grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3";
/** The same line inside the Over SSH box (its border and 8 px padding come off the label column). */
export const boxRowClass = "grid h-7 grid-cols-[calc(104px-0.5rem-1px)_minmax(0,1fr)] items-center gap-x-3";
export const labelClass = "truncate text-right text-text-2";
/** A label inside the field column (Port next to Host, Tag next to the colours). */
export const inlineLabelClass = "shrink-0 text-text-2";
export const fieldClass =
  "h-7 w-full min-w-0 rounded-md border border-pill-border bg-search px-2 text-text outline-none placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent read-only:text-text-2";
/**
 * A button without its text colour, for a coloured variant (`text-danger-text`): Tailwind
 * orders `.text-text` / `.text-icon` after `.text-danger-text`, so one colour per button (#129).
 */
export const buttonBaseClass =
  "h-7 shrink-0 rounded-md border border-pill-border bg-btn px-3 outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent disabled:opacity-50";
export const buttonClass = `${buttonBaseClass} text-text`;
export const primaryButtonClass =
  "h-7 shrink-0 rounded-md bg-accent-strong px-3 text-accent-contrast outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
export const iconButtonBaseClass =
  "flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-seg-sel focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent disabled:opacity-50";
export const iconButtonClass = `${iconButtonBaseClass} text-icon`;
