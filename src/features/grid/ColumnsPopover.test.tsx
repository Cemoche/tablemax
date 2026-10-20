import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import { useGridViews } from "../../stores/gridViews";
import { ColumnsPopover } from "./ColumnsPopover";

const c = strings.grid.columnsPopover;
const KEY = "layout-key";
const cols = ["id", "status", "total", "notes"];
let onClose: ReturnType<typeof vi.fn<(refocus: boolean) => void>>;

beforeEach(() => {
  onClose = vi.fn<(refocus: boolean) => void>();
  useGridViews.setState({ views: {}, trails: {}, layouts: {} });
});

const layout = () => useGridViews.getState().layouts[KEY];
const box = (name: string) => screen.getByRole("checkbox", { name });

test("columns_popover_hides_columns: unchecking hides a column of the table's layout; Show all brings them back", async () => {
  useGridViews.getState().setLayout(KEY, { order: ["status", "id"], hidden: ["notes"] });
  render(<ColumnsPopover columns={cols} layoutKey={KEY} onClose={onClose} />);
  expect(screen.getByRole("dialog", { name: c.label })).toBeInTheDocument();
  // In display order (new columns appended), checked when shown; the first has the focus.
  expect(screen.getAllByRole("checkbox").map((b) => b.getAttribute("aria-label"))).toEqual([
    "status",
    "id",
    "total",
    "notes",
  ]);
  expect(box("status")).toHaveFocus();
  expect(box("notes")).not.toBeChecked();
  await userEvent.click(box("total"));
  expect(layout().hidden).toEqual(["notes", "total"]);
  expect(box("total")).not.toBeChecked();
  // The keyboard works too (Space on the focused checkbox).
  box("id").focus();
  await userEvent.keyboard(" ");
  expect(layout().hidden).toEqual(["notes", "total", "id"]);
  // The last shown column cannot be hidden.
  expect(box("status")).toBeDisabled();
  expect(box("status")).toHaveAccessibleDescription(c.lastShown);
  await userEvent.click(screen.getByRole("button", { name: c.showAll }));
  expect(layout().hidden).toEqual([]);
  expect(screen.getByRole("button", { name: c.showAll })).toBeDisabled();
  // Widths and order are left alone.
  expect(layout().order).toEqual(["status", "id"]);
});

test("Escape closes it and asks for the focus back", async () => {
  render(<ColumnsPopover columns={cols} layoutKey={KEY} onClose={onClose} />);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledWith(true);
});
