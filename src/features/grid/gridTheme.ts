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
/** The row numbers' font size in px: 2 px under the data, at least 9. */
export function markerFontSize(dataFontSize: number): number {
  return Math.max(9, dataFontSize - 2);
}

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
 * see `headerFont`). `accentColor` is the active cell's border (`--cell-focus`); links (the FK
 * indicator) are text in `--accent-text` (#129: the accent itself is under 4.5:1),
 * `--row-selected` the selected rows (`buildRowThemes`).
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
    // NULL / EMPTY / DEFAULT placeholders (see `muted`); row numbers: buildRowNumberColors.
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
    linkColor: v("--accent-text", accent),
    fontFamily: monoFamily ?? v("--font-mono", FALLBACK_MONO),
    baseFontStyle: `${dataFontSize}px`,
    headerFontStyle: `500 ${uiSize}`,
    markerFontStyle: `${markerFontSize(dataFontSize)}px`,
    editorFontSize: `${dataFontSize}px`,
  };
}

export interface RowThemes {
  /** Every other row (zebra, `--row-b`). */
  odd: Partial<Theme>;
  /** A selected row, or a row of the current range: `--row-selected`, white text. */
  selected: Partial<Theme>;
}

/** The row numbers' own colours and font (see `rowNumberRenderer`). */
export interface RowNumberColors {
  /** The interface font: the numbers stand apart from the data's mono font. */
  family: string;
  /** Every number cell: the column header's background (`--grid-head`), no zebra (#103). */
  fill: string;
  /** Every number: the column header's text (`--head-text`). */
  text: string;
  /** A selected row's number cell (`--row-selected`, white reads 4.5:1 on it). */
  selectedFill: string;
  /** A selected row's number (`--row-selected-text`). */
  selectedText: string;
  /**
   * A failed row's number (`--danger-text`, #129): the row's red cue that stays on an
   * inserted or deleted row, whose cells keep the fill's text.
   */
  failedText: string;
}

/** Colours of the row numbers and their font (missing tokens: the row's own). */
export function buildRowNumberColors(readVar: ReadVar = readCssVar): RowNumberColors {
  return {
    family: readVar("--font-ui") || FALLBACK_FONT,
    fill: readVar("--grid-head"),
    text: readVar("--head-text"),
    selectedFill: readVar("--row-selected"),
    selectedText: readVar("--row-selected-text"),
    failedText: readVar("--danger-text"),
  };
}

/** Row overrides: zebra and selected rows (missing tokens override nothing). */
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
    // The deeper accent (#103): white on the §5.1 accent reads only 4.0:1.
    selected: only([
      ["bgCell", "--row-selected"],
      // Glide blends `accentLight` over a selected cell: the fill over itself stays the fill.
      ["accentLight", "--row-selected"],
      ["textDark", "--row-selected-text"],
      ["textMedium", "--row-selected-text"],
      ["textLight", "--row-selected-text"],
      ["linkColor", "--row-selected-text"],
    ]),
  };
}

export interface EditThemes {
  /**
   * A cell with a pending value: its value, placeholder and FK indicator in the text that
   * reads best on --modified (the accent text reads 2.5:1 there in dark, #129; the
   * placeholder colour under 3:1, #136).
   */
  edited: Partial<Theme>;
  /**
   * A cell with a pending value on a selected row (or a failed one, #129): it keeps
   * --modified as its fill and its selection fill (the edit stays visible) and drops the
   * row's white (or red) text for the one that reads best on --modified.
   */
  editedOnAccent: Partial<Theme>;
  /**
   * A row to insert: --inserted under --cell-text, which DataGrid also gives its DEFAULT /
   * NULL placeholders (the dim --placeholder is under 3:1 on the fills, #136).
   */
  inserted: Partial<Theme>;
  /**
   * A row to delete: --deleted under --deleted-text (#136), struck through by DataGrid; its
   * placeholders and FK indicator in the same text.
   */
  deleted: Partial<Theme>;
  /**
   * A row whose change failed to apply: its text in --danger-text (#129). DataGrid lays it
   * on plain rows only: on a change fill (inserted, deleted, edited) the fill's text wins.
   */
  failed: Partial<Theme>;
}

/**
 * Overrides for pending changes (tokens --modified, --inserted, --deleted and the text on
 * them, 4.5:1 in both themes: tokens.test.ts, #136); a missing token overrides nothing.
 */
export function buildEditThemes(readVar: ReadVar = readCssVar): EditThemes {
  const only = (key: keyof Theme, token: string): Partial<Theme> => {
    const v = readVar(token);
    return v ? { [key]: v } : {};
  };
  /** Every text the grid draws on a fill (data, placeholders, FK indicator) in `color`. */
  const textIn = (color: string): Partial<Theme> =>
    color ? { textDark: color, textMedium: color, textLight: color, linkColor: color } : {};
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
  const text = textIn(best);
  return {
    edited: { ...only("bgCell", "--modified"), ...text },
    // Glide fills a selected cell with the opaque accentLight over bgCell (a row selected by
    // its number, the active cell's range): --modified there too keeps the edit visible under
    // its readable text, while the row's accent and the --cell-focus ring show the selection.
    editedOnAccent: { ...only("bgCell", "--modified"), ...only("accentLight", "--modified"), ...text },
    // A new row has no FK indicator (nothing loaded to reference yet), but its colour follows anyway.
    inserted: { ...only("bgCell", "--inserted"), ...textIn(cellText) },
    deleted: { ...only("bgCell", "--deleted"), ...textIn(readVar("--deleted-text")) },
    failed: only("textDark", "--danger-text"),
  };
}

/**
 * The inner band of the focused cell's two-tone ring (#135). Glide strokes its ring in
 * `accentColor` (--cell-focus) on the cell's edge pixels (columns x and x + width, rows y and
 * y + height; one pixel in on the last column / row); this draws `color`
 * (--focus-ring-inner) on the next pixels in, so the ring reads 3:1 on every fill under it
 * (the red alone is under 3:1 on --sel, the change fills and the selected rows).
 */
export function drawFocusInnerBand(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  color: string,
  lastCol: boolean,
  lastRow: boolean,
): void {
  /** The band's right and bottom pixels. */
  const right = rect.x + rect.width - (lastCol ? 2 : 1);
  const bottom = rect.y + rect.height - (lastRow ? 2 : 1);
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, right - rect.x - 1, bottom - rect.y - 1);
  ctx.restore();
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
      /** The focused cell's inner band (`drawFocusInnerBand`); "" draws none. */
      focusInner: readVar("--focus-ring-inner"),
      fontSize: size,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, size, mono, monoReady]);
}
