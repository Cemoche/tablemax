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
