/** Inclusive bounds of the numeric settings. They mirror the constants of src-tauri/src/settings.rs. */
export const SETTINGS_BOUNDS = {
  editorFontSize: { min: 10, max: 24 },
  pageSize: { min: 50, max: 5000 },
  exactCountThreshold: { min: 10_000, max: 100_000_000 },
  autoLimitValue: { min: 1, max: 1_000_000 },
} as const;

export type NumericSettingKey = keyof typeof SETTINGS_BOUNDS;

/** The integer typed in `text`, or null when it is not a whole number within the bounds of `key`. */
export function parseBounded(key: NumericSettingKey, text: string): number | null {
  const t = text.trim().replace(/[ _,]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  const { min, max } = SETTINGS_BOUNDS[key];
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export const FONT_FAMILY_MAX = 200;
const FONT_NAME = /^[A-Za-z0-9 _-]*[A-Za-z0-9_-][A-Za-z0-9 _-]*$/;

/**
 * Mirrors `is_valid_font_family` in src-tauri/src/settings.rs: "" (default font), or
 * comma-separated names, each unquoted (ASCII letters, digits, spaces, `-`, `_`) or wholly
 * quoted with `'` or `"` around the same characters; at most 200 characters. ASCII only on
 * purpose, so nothing CSS reads as syntax (`; { } ( ) : / \ < >`, stray quotes) can pass.
 */
export function isValidFontFamily(text: string): boolean {
  if (text === "") return true;
  if (text.length > FONT_FAMILY_MAX) return false;
  return text.split(",").every((part) => {
    const p = part.replace(/^ +| +$/g, "");
    if (FONT_NAME.test(p)) return true;
    const q = p[0];
    return (q === "'" || q === '"') && p.length >= 2 && p.endsWith(q) && FONT_NAME.test(p.slice(1, -1));
  });
}
