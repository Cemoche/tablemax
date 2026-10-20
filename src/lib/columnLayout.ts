/**
 * What is kept per table of a grid (gridViews): widths dragged or fitted by hand, the
 * column order and the hidden columns, by column name. Read it back through
 * `reconcileLayout` (features/grid/columnLayout.ts): the table's columns may have changed.
 */
export interface ColumnLayout {
  widths: Record<string, number>;
  order: string[];
  hidden: string[];
}
