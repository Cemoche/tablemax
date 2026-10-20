import type { Theme } from "@glideapps/glide-data-grid";
import { useEffect, useMemo, useState } from "react";
import { contrastRatio } from "../../lib/contrast";
import { useSettings } from "../../stores/settings";

export type ReadVar = (name: string) => string;

export const readCssVar: ReadVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** CSS system colors, used only when a token is missing (never a hardcoded palette). */
const FALLBACK_BG = "Canvas";
const FALLBACK_FG = "CanvasText";
const FALLBACK_FONT = "system-ui, sans-serif";
const FALLBACK_MONO = "ui-monospace, monospace";
const FALLBACK_SIZE = "13px";
/** The data font size when the settings say nothing (spec §2.2). */
export const DEFAULT_DATA_FONT_SIZE = 13;
/** NULL / EMPTY / DEFAULT are this much smaller than the data (11.5 px at 13 px, spec §2.3). */
const PLACEHOLDER_SHRINK = 1.5;

const tokens = (readVar: ReadVar) => (name: string, fallback: string) => readVar(name) || fallback;

/** The header font: the interface font, medium, at the interface size (not the data size). */
export function headerFont(readVar: ReadVar = readCssVar): string {
  const v = tokens(readVar);
  return `500 ${v("--text-md", FALLBACK_SIZE)} ${v("--font-ui", FALLBACK_FONT)}`;
}

/**
 * Builds Glide's canvas theme from the design tokens (spec §5.1: grid tokens). Data in
 * `--font-mono` at `dataFontSize` (`monoFamily` replaces the token's family list while the
 * web font loads); headers medium at the interface size (their family is set per column:
 * see `headerFont`). `accentColor` is the active cell's border (`--cell-focus`); the accent
 * itself colours links and selected rows (`buildRowThemes`).
 */
export function buildGridTheme(
  readVar: ReadVar = readCssVar,
  dataFontSize: number = DEFAULT_DATA_FONT_SIZE,
  monoFamily?: string,
): Partial<Theme> {
  const v = tokens(readVar);
  const uiSize = v("--text-md", FALLBACK_SIZE);
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
    // NULL / EMPTY / DEFAULT placeholders (see `muted`); row numbers use --rownum.
    textLight: placeholder,
    textHeader: v("--head-text", text),
    textHeaderSelected: onAccent,
    textBubble: text,
    borderColor: sep,
    horizontalBorderColor: sep,
    headerBottomBorderColor: sep,
    drilldownBorder: sep,
    accentColor: v("--cell-focus", accent),
    accentFg: onAccent,
    // Cells of a selection outside the highlighted rows (selected columns only).
    accentLight: sel,
    linkColor: accent,
    fontFamily: monoFamily ?? v("--font-mono", FALLBACK_MONO),
    baseFontStyle: `${dataFontSize}px`,
    headerFontStyle: `500 ${uiSize}`,
    markerFontStyle: `${Math.max(9, dataFontSize - 2)}px`,
    editorFontSize: `${dataFontSize}px`,
  };
}

export interface RowThemes {
  /** Every other row (zebra, `--row-b`). */
  odd: Partial<Theme>;
  /** A selected row, or a row of the current range: the accent, white text. */
  selected: Partial<Theme>;
  /** The row numbers column (`--rownum`). */
  rowNumber: Partial<Theme>;
}

/** The row numbers' own colours and font (see `rowNumberRenderer`). */
export interface RowNumberColors {
  /** The interface font: the numbers stand apart from the data's mono font. */
  family: string;
  /** A selected row's number cell (`--rownum-selected`, white reads 4.5:1 on it). */
  selectedFill: string;
  /** A selected row's number (`--row-selected-text`). */
  selectedText: string;
}

/** Colours of the row numbers on selected rows, and their font (missing tokens: the row's). */
export function buildRowNumberColors(readVar: ReadVar = readCssVar): RowNumberColors {
  return {
    family: readVar("--font-ui") || FALLBACK_FONT,
    selectedFill: readVar("--rownum-selected"),
    selectedText: readVar("--row-selected-text"),
  };
}

/** Row overrides: zebra, selected rows and the row numbers (missing tokens override nothing). */
export function buildRowThemes(readVar: ReadVar = readCssVar): RowThemes {
  const only = (pairs: [keyof Theme, string][]): Partial<Theme> => {
    const out: Partial<Theme> = {};
    for (const [key, token] of pairs) {
      const value = readVar(token);
      if (value) (out as Record<string, string>)[key] = value;
    }
    return out;
  };
  return {
    odd: only([["bgCell", "--row-b"]]),
    selected: only([
      ["bgCell", "--accent"],
      // Glide blends `accentLight` over a selected cell: the accent over itself stays the accent.
      ["accentLight", "--accent"],
      ["textDark", "--row-selected-text"],
      ["textMedium", "--row-selected-text"],
      ["textLight", "--row-selected-text"],
      ["linkColor", "--row-selected-text"],
    ]),
    rowNumber: only([["textLight", "--rownum"]]),
  };
}

export interface EditThemes {
  /** A cell with a pending value. */
  edited: Partial<Theme>;
  /**
   * A cell with a pending value on a selected row: it keeps --modified as its fill and its
   * selection fill (the edit stays visible) and drops the row's white text for the one
   * that reads best on --modified.
   */
  editedOnAccent: Partial<Theme>;
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
  const modified = readVar("--modified");
  const cellText = readVar("--cell-text") || readVar("--text");
  const onAccent = readVar("--row-selected-text");
  /** The candidate with the higher contrast on --modified (--cell-text when they cannot be compared). */
  const best = (() => {
    if (!modified || !cellText) return cellText || onAccent;
    try {
      return onAccent && contrastRatio(onAccent, modified) > contrastRatio(cellText, modified) ? onAccent : cellText;
    } catch {
      return cellText;
    }
  })();
  const text: Partial<Theme> = best ? { textDark: best, textMedium: best, textLight: best, linkColor: best } : {};
  return {
    edited: only("bgCell", "--modified"),
    // Glide fills a selected cell with the opaque accentLight over bgCell (a row selected by
    // its number, the active cell's range): --modified there too keeps the edit visible under
    // its readable text, while the row's accent and the --cell-focus ring show the selection.
    editedOnAccent: { ...only("bgCell", "--modified"), ...only("accentLight", "--modified"), ...text },
    inserted: only("bgCell", "--inserted"),
    deleted: { ...only("bgCell", "--deleted"), ...only("textDark", "--text-2") },
    failed: only("textDark", "--danger"),
  };
}

/** The families after the first one of a CSS font-family list (the web font's fallbacks). */
function fallbackFamilies(list: string): string {
  const i = list.indexOf(",");
  return i < 0 ? FALLBACK_MONO : list.slice(i + 1).trim();
}

/**
 * Whether the data font (the first family of `--font-mono`) is ready to draw. A canvas
 * never asks for a web font by itself, so it is loaded here; until then the grid draws
 * with the fallback families, and once it is there the theme changes (new font string:
 * Glide redraws every cell and measures text again).
 */
function useMonoReady(mono: string, size: number): boolean {
  const spec = `${size}px ${mono}`;
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const known = fonts === undefined || typeof fonts.check !== "function" || ready[spec] === true;
  let loaded = known;
  if (!known) {
    try {
      loaded = fonts!.check(spec);
    } catch {
      loaded = true;
    }
  }
  useEffect(() => {
    if (loaded || !fonts) return;
    let live = true;
    fonts.load(spec).then(
      () => live && setReady((r) => ({ ...r, [spec]: true })),
      // A font that fails to load stays on its fallback: draw with that.
      () => live && setReady((r) => ({ ...r, [spec]: true })),
    );
    return () => {
      live = false;
    };
  }, [loaded, fonts, spec]);
  return loaded;
}

/**
 * Theme, row themes and the muted (placeholder) override, rebuilt when the OS color scheme
 * or `data-theme` changes, when the data font size changes, and once the mono font loaded.
 */
export function useGridTheme(readVar: ReadVar = readCssVar, fontSize?: number) {
  const settingsSize = useSettings((s) => s.settings.dataFontSize);
  const size = fontSize ?? settingsSize ?? DEFAULT_DATA_FONT_SIZE;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mono = useMemo(() => readVar("--font-mono") || FALLBACK_MONO, [rev]);
  const monoReady = useMonoReady(mono, size);
  return useMemo(() => {
    const theme = buildGridTheme(readVar, size, monoReady ? mono : fallbackFamilies(mono));
    const muted: Partial<Theme> = {
      textDark: readVar("--placeholder") || theme.textLight,
      baseFontStyle: `${size - PLACEHOLDER_SHRINK}px`,
    };
    return {
      theme,
      muted,
      rows: buildRowThemes(readVar),
      rowNumbers: buildRowNumberColors(readVar),
      header: headerFont(readVar),
      edit: buildEditThemes(readVar),
      fontSize: size,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, size, mono, monoReady]);
}
