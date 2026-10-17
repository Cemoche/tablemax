import type { Theme } from "@glideapps/glide-data-grid";
import { useEffect, useMemo, useState } from "react";

export type ReadVar = (name: string) => string;

export const readCssVar: ReadVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** CSS system colors, used only when a token is missing (never a hardcoded palette). */
const FALLBACK_BG = "Canvas";
const FALLBACK_FG = "CanvasText";
const FALLBACK_FONT = "system-ui, sans-serif";
const FALLBACK_SIZE = "13px";

/** Builds Glide's canvas theme from the design tokens. */
export function buildGridTheme(readVar: ReadVar = readCssVar): Partial<Theme> {
  const v = (name: string, fallback: string) => readVar(name) || fallback;
  const size = v("--text-md", FALLBACK_SIZE);
  const surface = v("--surface", FALLBACK_BG);
  const surface2 = v("--surface-2", surface);
  const text = v("--text", FALLBACK_FG);
  const muted = v("--text-muted", text);
  const border = v("--border", muted);
  const accent = v("--accent", text);
  const accentContrast = v("--accent-contrast", surface);
  return {
    bgCell: surface,
    bgCellMedium: surface,
    bgHeader: surface2,
    bgHeaderHasFocus: surface2,
    bgHeaderHovered: surface2,
    bgBubble: surface2,
    textDark: text,
    textMedium: muted,
    textLight: muted,
    textHeader: text,
    textHeaderSelected: accentContrast,
    textBubble: text,
    borderColor: border,
    horizontalBorderColor: border,
    drilldownBorder: border,
    accentColor: accent,
    accentFg: accentContrast,
    accentLight: surface2,
    linkColor: accent,
    fontFamily: v("--font-ui", FALLBACK_FONT),
    baseFontStyle: size,
    headerFontStyle: `600 ${size}`,
    editorFontSize: size,
  };
}

export interface EditThemes {
  /** A cell with a pending value. */
  edited: Partial<Theme>;
  /** A row to insert. */
  inserted: Partial<Theme>;
  /** A row to delete (its text is also struck through by DataGrid). */
  deleted: Partial<Theme>;
  /** A row whose change failed to apply. */
  failed: Partial<Theme>;
}

/** Overrides for pending changes (tokens --pending-*); a missing token overrides nothing. */
export function buildEditThemes(readVar: ReadVar = readCssVar): EditThemes {
  const only = (key: keyof Theme, token: string): Partial<Theme> => {
    const v = readVar(token);
    return v ? { [key]: v } : {};
  };
  return {
    edited: only("bgCell", "--pending-edit"),
    inserted: only("bgCell", "--pending-insert"),
    deleted: { ...only("bgCell", "--pending-delete"), ...only("textDark", "--text-muted") },
    failed: only("textDark", "--danger"),
  };
}

/** Theme + muted-cell override, rebuilt whenever the OS color scheme changes. */
export function useGridTheme(readVar: ReadVar = readCssVar) {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setRev((r) => r + 1);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return useMemo(() => {
    const theme = buildGridTheme(readVar);
    const muted: Partial<Theme> = { textDark: theme.textMedium };
    return { theme, muted, edit: buildEditThemes(readVar) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
}
