import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import type { Dialect, Filter, FilterCombine } from "../../lib/types";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { FilterBar } from "./FilterBar";

const cols = ["status", "total", "id", "notes"];
const f = strings.filters;
let onApply: ReturnType<typeof vi.fn<(filters: Filter[], combine: FilterCombine) => boolean>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  onApply = vi.fn<(filters: Filter[], combine: FilterCombine) => boolean>(() => true);
  onClose = vi.fn<() => void>();
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
});

interface SetupProps {
  filters?: Filter[];
  combine?: FilterCombine;
  dialect?: Dialect;
  focusSeq?: number;
  start?: { column: string; seq: number } | null;
}

function ui({ filters = [], combine = "and", dialect = "postgres", focusSeq = 0, start = null }: SetupProps = {}) {
  return (
    <FilterBar
      id="fb"
      dialect={dialect}
      columns={cols}
      filters={filters}
      combine={combine}
      onApply={onApply}
      onClose={onClose}
      focusSeq={focusSeq}
      start={start}
    />
  );
}
const setup = (p: SetupProps = {}) => render(ui(p));

const eq = (column: string, v: string): Filter => ({ column, op: "eq", values: [v] });
const value = (row: number) => screen.getByRole("textbox", { name: f.valueLabel(row) });
const column = (row: number) => screen.getByRole("combobox", { name: f.columnLabel(row) });
const op = (row: number) => screen.getByRole("combobox", { name: f.opLabel(row) });
const check = (row: number) => screen.getByRole("checkbox", { name: f.enabledLabel(row) });
const rowGroup = (row: number) => screen.getByRole("group", { name: new RegExp(`^${f.rowLabel(row, false)}`) });
const optionValues = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);
/** Two typed rows: status = paid, total > 5. */
async function twoRows() {
  setup();
  await userEvent.selectOptions(column(1), "status");
  await userEvent.type(value(1), "paid");
  await userEvent.click(screen.getByRole("button", { name: f.addAfter(1) }));
  await userEvent.selectOptions(column(2), "total");
  await userEvent.selectOptions(op(2), "gt");
  await userEvent.type(value(2), "5");
}

test("apply_row_applies_only_that_filter: Apply and Enter apply their own row alone, with AND", async () => {
  await twoRows();
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(2) }));
  expect(onApply).toHaveBeenLastCalledWith([{ column: "total", op: "gt", values: ["5"] }], "and");
  await userEvent.type(value(1), "{Enter}");
  expect(onApply).toHaveBeenLastCalledWith([eq("status", "paid")], "and");
  expect(onApply).toHaveBeenCalledTimes(2);
});

test("apply_all_and_or: Apply All joins the checked rows with AND or OR (buttons and Ctrl+Enter / Ctrl+Shift+Enter)", async () => {
  await twoRows();
  const both = [eq("status", "paid"), { column: "total", op: "gt", values: ["5"] }];
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(onApply).toHaveBeenLastCalledWith(both, "and");
  // OR is chosen in the segmented control, then Apply All.
  await userEvent.click(screen.getByRole("button", { name: f.combineOr }));
  expect(screen.getByRole("button", { name: f.combineOr })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(onApply).toHaveBeenLastCalledWith(both, "or");
  // The keys apply at once, from any field of the bar, and set the choice.
  value(1).focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onApply).toHaveBeenLastCalledWith(both, "and");
  expect(screen.getByRole("button", { name: f.combineAnd })).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
  expect(onApply).toHaveBeenLastCalledWith(both, "or");
  // An unchecked row is left out.
  await userEvent.click(check(1));
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onApply).toHaveBeenLastCalledWith([{ column: "total", op: "gt", values: ["5"] }], "and");
});

test("ctrl_b_toggles_filter: Ctrl+B turns the focused row on and off", async () => {
  await twoRows();
  value(2).focus();
  expect(check(2)).toBeChecked();
  await userEvent.keyboard("{Control>}b{/Control}");
  expect(check(2)).not.toBeChecked();
  expect(value(2)).toHaveFocus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onApply).toHaveBeenLastCalledWith([eq("status", "paid")], "and");
  await userEvent.keyboard("{Control>}b{/Control}");
  expect(check(2)).toBeChecked();
  // A custom combination replaces Ctrl+B.
  act(() =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "filters.toggle": "Alt+T" } } }),
  );
  await userEvent.keyboard("{Control>}b{/Control}");
  expect(check(2)).toBeChecked();
  await userEvent.keyboard("{Alt>}t{/Alt}");
  expect(check(2)).not.toBeChecked();
});

test("ctrl_b_from_every_field: Ctrl+B toggles the row of the focused value, column, operator or checkbox (#102)", async () => {
  await twoRows();
  for (const target of [value(2), column(2), op(2), check(2)]) {
    target.focus();
    expect(check(2), target.getAttribute("aria-label") ?? "").toBeChecked();
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(check(2), target.getAttribute("aria-label") ?? "").not.toBeChecked();
    expect(target).toHaveFocus();
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(check(2)).toBeChecked();
  }
  expect(check(1)).toBeChecked();
});

test("ctrl_b_after_apply_all: with the focus on Apply All or AND / OR, Ctrl+B toggles the row last focused (#102)", async () => {
  await twoRows();
  // Clicking a button focuses it (WebKitGTK and jsdom): the focus leaves the rows.
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(screen.getByRole("button", { name: f.applyAll })).toHaveFocus();
  await userEvent.keyboard("{Control>}b{/Control}");
  expect(check(2)).not.toBeChecked();
  expect(check(1)).toBeChecked();
  value(1).focus();
  await userEvent.click(screen.getByRole("button", { name: f.combineOr }));
  await userEvent.keyboard("{Control>}b{/Control}");
  expect(check(1)).not.toBeChecked();
  expect(check(2)).not.toBeChecked();
});

test("raw_sql_mode_uses_quick_syntax: Raw SQL takes the quick syntax as bound filters, other text as SQL", async () => {
  setup();
  await userEvent.selectOptions(column(1), f.rawSql);
  expect(screen.queryByRole("combobox", { name: f.opLabel(1) })).toBeNull();
  const raw = screen.getByRole("textbox", { name: f.rawLabel(1) });
  await userEvent.type(raw, "notes contains 'x'{Enter}");
  expect(onApply).toHaveBeenLastCalledWith([{ column: "notes", op: "contains", values: ["x"] }], "and");
  await userEvent.clear(raw);
  await userEvent.type(raw, "total > 2 * id{Enter}");
  expect(onApply).toHaveBeenLastCalledWith([{ column: null, op: "raw", values: ["total > 2 * id"] }], "and");
  // Blank SQL is an error under the row; nothing is applied.
  await userEvent.clear(raw);
  await userEvent.type(raw, "{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent(f.rawEmpty);
  expect(onApply).toHaveBeenCalledTimes(2);
});

test("filter_bar_keyboard_flow: every control has a name, Tab walks a row, Ctrl+I / Ctrl+Shift+I add and remove rows", async () => {
  const user = userEvent.setup();
  setup({ focusSeq: 1 });
  // Opened from Ctrl+F or the Filters button: the first row's column has the focus.
  expect(column(1)).toHaveFocus();
  await user.tab();
  expect(op(1)).toHaveFocus();
  await user.tab();
  expect(value(1)).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: f.applyRow(1) })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: f.addAfter(1) })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: f.removeRow(1) })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: f.applyAll })).toHaveFocus();
  for (let i = 0; i < 7; i++) await user.tab({ shift: true });
  expect(check(1)).toHaveFocus();
  // Ctrl+I adds a row after the focused one and focuses its column.
  value(1).focus();
  await user.keyboard("{Control>}i{/Control}");
  expect(column(2)).toHaveFocus();
  await user.keyboard("{Control>}i{/Control}");
  expect(column(3)).toHaveFocus();
  expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  // Ctrl+Shift+I removes the focused row; the focus stays on the row now in its place.
  column(2).focus();
  await user.keyboard("{Control>}{Shift>}i{/Shift}{/Control}");
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(column(2)).toHaveFocus();
  await user.keyboard("{Control>}{Shift>}i{/Shift}{/Control}");
  expect(column(1)).toHaveFocus();
  // The last row cannot go: it becomes a blank row.
  await user.keyboard("{Control>}{Shift>}i{/Shift}{/Control}");
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(column(1)).toHaveFocus();
  // The keys never reach the table tab (+ Row is Ctrl+I there).
  const outer = vi.fn();
  window.addEventListener("keydown", outer);
  onTestFinished(() => window.removeEventListener("keydown", outer));
  await user.keyboard("{Control>}i{/Control}");
  expect(outer.mock.calls.some(([e]) => (e as KeyboardEvent).code === "KeyI")).toBe(false);
  // Shortcuts are announced on their controls.
  expect(screen.getByRole("button", { name: f.applyAll })).toHaveAttribute("aria-keyshortcuts", "Control+Enter");
  expect(screen.getByRole("button", { name: f.addAfter(1) })).toHaveAttribute("aria-keyshortcuts", "Control+I");
});

test("escape_closes_empty_bar: Escape closes a bar with nothing typed or applied, not otherwise", async () => {
  const { rerender } = setup({ focusSeq: 1 });
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  // Something typed: the bar stays.
  await userEvent.type(value(1), "x");
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  // Something applied: the bar stays too.
  rerender(ui({ filters: [eq("id", "1")] }));
  value(1).focus();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Ctrl+F in the bar closes it (the table tab's Filters key)", async () => {
  setup({ filters: [eq("id", "1")] });
  value(1).focus();
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("applied rows are tinted and say so; an edit or a refused apply drops the tint", async () => {
  await twoRows();
  expect(rowGroup(1)).not.toHaveAttribute("data-applied");
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  // The parent applies: the view now holds these filters.
  expect(rowGroup(1)).toHaveAttribute("data-applied", "true");
  expect(rowGroup(1)).toHaveAccessibleName(f.rowLabel(1, true));
  await userEvent.type(value(1), "!");
  expect(rowGroup(1)).not.toHaveAttribute("data-applied");
  expect(rowGroup(2)).toHaveAttribute("data-applied", "true");
  onApply.mockReturnValue(false);
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(1) }));
  expect(rowGroup(1)).not.toHaveAttribute("data-applied");
  // What was typed stays.
  expect(value(1)).toHaveValue("paid!");
});

test("removing an applied row applies the others again; an unapplied row goes quietly", async () => {
  await twoRows();
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(2) }));
  onApply.mockClear();
  await userEvent.click(screen.getByRole("button", { name: f.removeRow(1) }));
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: f.removeRow(1) }));
  expect(onApply).toHaveBeenCalledWith([], "and");
});

test("the bar follows filters applied elsewhere (quick filter, foreign key), checked and tinted", () => {
  const { rerender } = setup();
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  rerender(ui({ filters: [eq("status", "paid"), { column: null, op: "raw", values: ["id > 2"] }], combine: "or" }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(column(1)).toHaveValue("c:status");
  expect(value(1)).toHaveValue("paid");
  expect(screen.getByRole("textbox", { name: f.rawLabel(2) })).toHaveValue("id > 2");
  expect(rowGroup(2)).toHaveAttribute("data-applied", "true");
  expect(screen.getByRole("button", { name: f.combineOr })).toHaveAttribute("aria-pressed", "true");
});

test("Filter with column: a row on that column, its value focused (the blank row is reused)", async () => {
  const { rerender } = setup();
  rerender(ui({ start: { column: "notes", seq: 1 } }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(column(1)).toHaveValue("c:notes");
  expect(value(1)).toHaveFocus();
  await userEvent.type(value(1), "x");
  rerender(ui({ start: { column: "id", seq: 2 } }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(column(2)).toHaveValue("c:id");
  expect(value(2)).toHaveFocus();
});

test("the operators follow the column: ILIKE on PostgreSQL only, four for Any column", async () => {
  setup({ dialect: "mySql" });
  expect(optionValues(op(1))).not.toContain("ILIKE");
  await userEvent.selectOptions(column(1), f.anyColumn);
  expect(optionValues(op(1))).toEqual(["=", "contains", "not contains", "LIKE"]);
});

test("value fields per operator: two for BETWEEN, a list for IN, none for IS NULL", async () => {
  setup();
  await userEvent.selectOptions(column(1), "total");
  await userEvent.selectOptions(op(1), "BETWEEN");
  await userEvent.type(value(1), "1");
  await userEvent.type(screen.getByRole("textbox", { name: f.secondValueLabel(1) }), "9");
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(1) }));
  expect(onApply).toHaveBeenLastCalledWith([{ column: "total", op: "between", values: ["1", "9"] }], "and");
  await userEvent.selectOptions(op(1), "IN");
  const list = screen.getByRole("textbox", { name: f.listLabel(1) });
  await userEvent.clear(list);
  await userEvent.type(list, "1, 2{Enter}");
  expect(onApply).toHaveBeenLastCalledWith([{ column: "total", op: "in", values: ["1", "2"] }], "and");
  await userEvent.selectOptions(op(1), "IS NULL");
  expect(screen.queryByRole("textbox", { name: f.valueLabel(1) })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(1) }));
  expect(onApply).toHaveBeenLastCalledWith([{ column: "total", op: "isNull", values: [] }], "and");
});

test("a row error blocks Apply All; untouched blank rows are left out", async () => {
  setup();
  await userEvent.selectOptions(op(1), "IN");
  await userEvent.type(screen.getByRole("textbox", { name: f.listLabel(1) }), "1,,2");
  await userEvent.click(screen.getByRole("button", { name: f.addAfter(1) }));
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(screen.getByRole("alert")).toHaveTextContent(/empty value/);
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: f.removeRow(1) }));
  // Only the untouched row 2 is left (now row 1): Apply All clears the filters.
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(onApply).toHaveBeenLastCalledWith([], "and");
});

test("a Raw SQL row says how it is read: filter syntax (bound) or SQL as written; under OR it may need SQL", async () => {
  setup();
  await userEvent.selectOptions(column(1), f.rawSql);
  const raw = screen.getByRole("textbox", { name: f.rawLabel(1) });
  const reading = () => within(rowGroup(1)).getByTestId("raw-reading");
  await userEvent.type(raw, "status = active");
  // `active` is no column: a value, bound.
  expect(reading()).toHaveTextContent(f.rawRead.bound);
  expect(raw).toHaveAccessibleDescription(`${f.rawRead.boundHint} ${f.rawRead.applyNote}`);
  // `id` is a column: two columns compared, in SQL.
  await userEvent.clear(raw);
  await userEvent.type(raw, "total = id");
  expect(reading()).toHaveTextContent(f.rawRead.sql);
  expect(raw).toHaveAccessibleDescription(`${f.rawRead.sqlHint} ${f.rawRead.applyNote}`);
  // Under OR, several conditions only the filter syntax knows: an error before sending.
  await userEvent.clear(raw);
  await userEvent.type(raw, "notes contains 'x' AND id = 1");
  expect(reading()).toHaveTextContent(f.rawRead.bound);
  await userEvent.click(screen.getByRole("button", { name: f.combineOr }));
  expect(reading()).toHaveTextContent(f.rawRead.error);
  expect(raw).toHaveAccessibleDescription(`${f.rawOrNeedsSql} ${f.rawRead.applyNote}`);
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(screen.getByRole("alert")).toHaveTextContent(f.rawOrNeedsSql);
  expect(onApply).not.toHaveBeenCalled();
  // Applied alone (AND) the row is fine.
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(1) }));
  expect(onApply).toHaveBeenLastCalledWith(
    [
      { column: "notes", op: "contains", values: ["x"] },
      { column: "id", op: "eq", values: ["1"] },
    ],
    "and",
  );
});

test("applying one row sets the join control back to AND (what is applied now)", async () => {
  await twoRows();
  await userEvent.click(screen.getByRole("button", { name: f.combineOr }));
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(1) }));
  expect(onApply).toHaveBeenLastCalledWith([eq("status", "paid")], "and");
  expect(screen.getByRole("button", { name: f.combineAnd })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: f.combineOr })).toHaveAttribute("aria-pressed", "false");
  // The row's Apply names its key as the platform writes it.
  expect(screen.getByRole("button", { name: f.applyRow(1) })).toHaveAttribute(
    "title",
    f.withShortcut(f.applyRow(1), formatShortcut("Enter")),
  );
});
