import { type DrawHeaderCallback, getMiddleCenterBias } from "@glideapps/glide-data-grid";

/**
 * Glide's `drawHeader`: column labels centred over their column (Glide draws them on the
 * left). A label wider than its column (less the cell padding on both sides), the row
 * numbers' corner and a column with an icon keep Glide's own drawing.
 */
export const drawCenteredHeader: DrawHeaderCallback = (args, drawContent) => {
  const { ctx, theme, rect, column, isSelected } = args;
  // Glide's mapped column carries `rowMarker` on the corner above the row numbers.
  const marker = (column as { rowMarker?: unknown }).rowMarker !== undefined;
  const font = (theme as { headerFontFull?: string }).headerFontFull;
  if (marker || column.icon !== undefined || !font) return drawContent();
  ctx.save();
  // The header font (spec §2.3: the interface font, medium), set here: with a column theme
  // override Glide leaves the data font on the context.
  ctx.font = font;
  if (ctx.measureText(column.title).width > rect.width - 2 * theme.cellHorizontalPadding) {
    ctx.restore();
    // Glide's drawing (left, cut) in the header font too, not the data font it left set;
    // Glide wraps each header in its own save / restore.
    ctx.font = font;
    return drawContent();
  }
  ctx.fillStyle = isSelected ? theme.textHeaderSelected : theme.textHeader;
  ctx.textAlign = "center";
  ctx.fillText(column.title, rect.x + rect.width / 2, rect.y + rect.height / 2 + getMiddleCenterBias(ctx, font));
  ctx.restore();
};
