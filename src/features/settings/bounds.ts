import { KEYMAP_ACTIONS, isValidShortcut } from "../../lib/keymapRegistry";

/** Inclusive bounds of the numeric settings. They mirror the constants of src-tauri/src/settings.rs. */
export const SETTINGS_BOUNDS = {
  editorFontSize: { min: 10, max: 24 },
  dataFontSize: { min: 10, max: 24 },
  pageSize: { min: 50, max: 5000 },
  exactCountThreshold: { min: 10_000, max: 100_000_000 },
  autoLimitValue: { min: 1, max: 1_000_000 },
} as const;

export type NumericSettingKey = keyof typeof SETTINGS_BOUNDS;

/**
 * The interface size choices, in percent: `INTERFACE_SCALE` of src-tauri/src/settings.rs
 * (0.9–1.3) on its 5 % step.
 */
export const INTERFACE_SCALE_PERCENTS: readonly number[] = Array.from({ length: 9 }, (_, i) => 90 + 5 * i);

/** The stored scale as the percent of its nearest step (a float read back may be 1.2999…). */
export function scalePercent(scale: number): number {
  const p = Math.round((scale * 100) / 5) * 5;
  return Math.min(130, Math.max(90, p));
}

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

/** Mirrors `KEYMAP_MAX_ENTRIES` in src-tauri/src/settings.rs. */
export const KEYMAP_MAX_ENTRIES = 96;

/**
 * Mirrors the keymap cleaning of `Settings::clamped` in src-tauri/src/settings.rs: only
 * entries with a known action id and a string value in the shortcut grammar
 * (`isValidShortcut`), at most `max` of them; anything but a plain object gives `{}`.
 */
export function cleanKeymap(raw: unknown, max: number = KEYMAP_MAX_ENTRIES): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  let kept = 0;
  for (const { id } of KEYMAP_ACTIONS) {
    if (kept >= max) break;
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const spec = (raw as Record<string, unknown>)[id];
    if (typeof spec === "string" && isValidShortcut(spec)) {
      out[id] = spec;
      kept++;
    }
  }
  return out;
}
