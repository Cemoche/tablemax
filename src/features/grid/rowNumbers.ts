import {
  AllCellRenderers,
  type DataEditorCoreProps,
  InnerGridCellKind,
  type MarkerCell,
  getMiddleCenterBias,
  markerCellRenderer,
} from "@glideapps/glide-data-grid";

type Renderer = NonNullable<DataEditorCoreProps["renderers"]>[number];

/** Space between a row number and the first data column. */
export const ROW_NUMBER_PAD = 8;
/** Spec §5.2 at 100 %: the numbers column is 46 px wide, wider only for long numbers. */
export const ROW_NUMBER_MIN_WIDTH = 46;
/** A digit's width in em, rounded up for the interface fonts (no canvas to measure in tests). */
const DIGIT_EM = 0.62;

/**
 * Width of the numbers column: room for the largest number (`rowCount`, numbers start at 1)
 * at `fontPx`, with ROW_NUMBER_PAD on both sides, never under ROW_NUMBER_MIN_WIDTH.
 */
export function rowNumberWidth(rowCount: number, fontPx: number): number {
  const digits = String(Math.max(1, Math.floor(rowCount))).length;
  return Math.max(ROW_NUMBER_MIN_WIDTH, Math.ceil(digits * fontPx * DIGIT_EM) + 2 * ROW_NUMBER_PAD);
}

/** How the row numbers are drawn, read at each draw (the theme and selection change). */
export interface RowNumberStyle {
  /** Is display row `row` selected (highlighted: selected rows, rows of the current range)? */
  selected: (row: number) => boolean;
  /** Font family of the numbers: the interface font, apart from the data's mono font. */
  family: string;
  /** Cell fill of a selected row's number (`--rownum-selected`); empty: the row's own. */
  selectedFill: string;
  /** Number colour on a selected row (`--row-selected-text`); empty: `textLight`. */
  selectedText: string;
}

/**
 * Glide's row marker renderer with the numbers right-aligned in the interface font, in
 * `textLight` (`--rownum`) on the row's own background (zebra included), smaller than the
 * data (`markerFontStyle`). A selected row's number sits on `selectedFill`, a deeper accent
 * that keeps the white number readable. Other marker kinds draw as Glide does.
 */
export function rowNumberRenderer(style: () => RowNumberStyle): Renderer {
  const draw: Renderer["draw"] = (args, cell) => {
    const marker = cell as MarkerCell;
    if (marker.markerKind !== "number") {
      // Other marker kinds (checkboxes): Glide's renderer, with its own prep.
      const glide = markerCellRenderer as Renderer;
      const prep = glide.drawPrep?.(args, undefined);
      glide.draw(args, marker);
      prep?.deprep?.(args);
      return;
    }
    const { ctx, rect, theme, row } = args;
    const s = style();
    const selected = s.selected(row);
    const font = `${theme.markerFontStyle} ${s.family}`;
    ctx.save();
    if (selected && s.selectedFill) {
      ctx.fillStyle = s.selectedFill;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.fillStyle = selected && s.selectedText ? s.selectedText : theme.textLight;
    ctx.font = font;
    ctx.textAlign = "right";
    ctx.fillText(
      String(marker.row),
      rect.x + rect.width - ROW_NUMBER_PAD,
      rect.y + rect.height / 2 + getMiddleCenterBias(ctx, font),
    );
    ctx.restore();
  };
  // No drawPrep: `draw` sets its own font and alignment and restores the context.
  return { ...(markerCellRenderer as Renderer), drawPrep: undefined, draw };
}

/** Glide's renderers with `rowNumberRenderer` for the row markers. */
export function gridRenderers(style: () => RowNumberStyle): readonly Renderer[] {
  return [
    rowNumberRenderer(style),
    ...(AllCellRenderers as readonly Renderer[]).filter((r) => r.kind !== InnerGridCellKind.Marker),
  ];
}
