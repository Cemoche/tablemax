/**
 * Classes of a connection color id (#104). Tailwind needs the literal class names. Unknown
 * ids fall back to the gray swatch.
 */
const TINT: Record<string, string> = {
  "swatch-1": "bg-swatch-1-tint text-swatch-1-tint-text",
  "swatch-2": "bg-swatch-2-tint text-swatch-2-tint-text",
  "swatch-3": "bg-swatch-3-tint text-swatch-3-tint-text",
  "swatch-4": "bg-swatch-4-tint text-swatch-4-tint-text",
  "swatch-5": "bg-swatch-5-tint text-swatch-5-tint-text",
  "swatch-6": "bg-swatch-6-tint text-swatch-6-tint-text",
};

const ICON: Record<string, string> = {
  "swatch-1": "text-swatch-1-icon",
  "swatch-2": "text-swatch-2-icon",
  "swatch-3": "text-swatch-3-icon",
  "swatch-4": "text-swatch-4-icon",
  "swatch-5": "text-swatch-5-icon",
  "swatch-6": "text-swatch-6-icon",
};

/** The status pill: a tint of the connection color and its text (≥ 4.5:1, tokens.test.ts). */
export const tintClass = (color: string): string => TINT[color] ?? TINT["swatch-4"];

/** An icon drawn in the connection color on a neutral tile (≥ 3:1, tokens.test.ts). */
export const iconColorClass = (color: string): string => ICON[color] ?? ICON["swatch-4"];
