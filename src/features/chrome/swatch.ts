/**
 * The connection color and its text color (≥ 4.5:1, tokens.test.ts). Tailwind needs the
 * literal class names. Unknown ids fall back to the gray swatch.
 */
const SWATCH: Record<string, string> = {
  "swatch-1": "bg-swatch-1 text-swatch-1-text",
  "swatch-2": "bg-swatch-2 text-swatch-2-text",
  "swatch-3": "bg-swatch-3 text-swatch-3-text",
  "swatch-4": "bg-swatch-4 text-swatch-4-text",
  "swatch-5": "bg-swatch-5 text-swatch-5-text",
  "swatch-6": "bg-swatch-6 text-swatch-6-text",
};

/** Background and text classes of a connection color id. */
export const swatchClass = (color: string): string => SWATCH[color] ?? SWATCH["swatch-4"];
