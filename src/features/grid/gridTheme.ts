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

/** Builds Glide's canvas theme from the design tokens (spec §5.1: grid tokens). */
export function buildGridTheme(readVar: ReadVar = readCssVar): Partial<Theme> {
  const v = (name: string, fallback: string) => readVar(name) || fallback;
  const size = v("--text-md", FALLBACK_SIZE);
  const row = v("--row-a", v("--content", FALLBACK_BG));
  const head = v("--grid-head", row);
  const text = v("--cell-text", v("--text", FALLBACK_FG));
  const secondary = v("--text-2", text);
  const placeholder = v("--placeholder", secondary);
  const sep = v("--grid-sep", secondary);
  const accent = v("--accent", text);
  const onAccent = v("--row-selected-text", row);
  const sel = v("--sel", head);
  return {
    bgCell: row,
    bgCellMedium: row,
    bgHeader: head,
    bgHeaderHasFocus: head,
    bgHeaderHovered: head,
    bgBubble: v("--seg-sel", head),
    textDark: text,
    textMedium: secondary,
    // NULL / EMPTY / DEFAULT placeholders (the `muted` override) and row numbers.
    textLight: placeholder,
    textHeader: v("--head-text", text),
    textHeaderSelected: onAccent,
    textBubble: text,
    borderColor: sep,
    horizontalBorderColor: sep,
    drilldownBorder: sep,
    accentColor: accent,
    accentFg: onAccent,
    accentLight: sel,
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

/** Overrides for pending changes (tokens --modified, --inserted, --deleted); a missing token overrides nothing. */
export function buildEditThemes(readVar: ReadVar = readCssVar): EditThemes {
  const only = (key: keyof Theme, token: string): Partial<Theme> => {
    const v = readVar(token);
    return v ? { [key]: v } : {};
  };
  return {
    edited: only("bgCell", "--modified"),
    inserted: only("bgCell", "--inserted"),
    deleted: { ...only("bgCell", "--deleted"), ...only("textDark", "--text-2") },
    failed: only("textDark", "--danger"),
  };
}

/** Theme + muted-cell (placeholder) override, rebuilt when the OS color scheme or `data-theme` changes. */
export function useGridTheme(readVar: ReadVar = readCssVar) {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const onChange = () => setRev((r) => r + 1);
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq =
      typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener("change", onChange);
    return () => {
      observer.disconnect();
      mq?.removeEventListener("change", onChange);
    };
  }, []);
  return useMemo(() => {
    const theme = buildGridTheme(readVar);
    const muted: Partial<Theme> = { textDark: theme.textLight };
    return { theme, muted, edit: buildEditThemes(readVar) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
}
