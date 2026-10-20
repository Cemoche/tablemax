import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import type { Dialect, Filter, FilterCombine, WherePreview } from "../../lib/types";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { TooltipLayer } from "../chrome/TooltipLayer";
import { FilterBar } from "./FilterBar";

const cols = ["status", "total", "id", "notes"];
const f = strings.filters;
const none: WherePreview = { sql: "", display: "" };
let onApply: ReturnType<typeof vi.fn<(filters: Filter[], combine: FilterCombine) => boolean>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let previewSql: ReturnType<typeof vi.fn<(filters: Filter[], combine: FilterCombine) => Promise<WherePreview>>>;

beforeEach(() => {
  onApply = vi.fn<(filters: Filter[], combine: FilterCombine) => boolean>(() => true);
  onClose = vi.fn<() => void>();
  previewSql = vi.fn<(filters: Filter[], combine: FilterCombine) => Promise<WherePreview>>(async () => none);
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
});

interface SetupProps {
  open?: boolean;
  filters?: Filter[];
  combine?: FilterCombine;
  dialect?: Dialect;
  focusSeq?: number;
  start?: { column: string; seq: number } | null;
}

function ui({ open = true, filters = [], combine = "and", dialect = "postgres", focusSeq = 0, start = null }: SetupProps = {}) {
  return (
    <FilterBar
      id="fb"
      open={open}
      dialect={dialect}
      columns={cols}
      filters={filters}
      combine={combine}
      onApply={onApply}
      onClose={onClose}
      previewSql={previewSql}
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
const footer = () => screen.getByRole("group", { name: f.footer });
const joinButton = (join: "AND" | "OR") => screen.getByRole("button", { name: f.combineButton(join) });
/** Apply All with AND or OR from the ⌄ menu. */
async function applyAllWith(join: "AND" | "OR") {
  await userEvent.click(screen.getByRole("button", { name: /^Apply All joins/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(`^${f.applyAllWith(join)}`) }));
}
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
  // OR is chosen in Apply All's ⌄ menu (#103): it applies, and the ⌄ says OR from then on.
  await applyAllWith("OR");
  expect(onApply).toHaveBeenLastCalledWith(both, "or");
  expect(joinButton("OR")).toHaveTextContent(f.combineOr);
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(onApply).toHaveBeenLastCalledWith(both, "or");
  // The keys apply at once, from any field of the bar, and set the choice.
  value(1).focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onApply).toHaveBeenLastCalledWith(both, "and");
  expect(joinButton("AND")).toBeInTheDocument();
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

test("ctrl_b_after_apply_all: with the focus on Apply All or another footer button, Ctrl+B toggles the row last focused (#102)", async () => {
  await twoRows();
  // Clicking a button focuses it (WebKitGTK and jsdom): the focus leaves the rows.
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(screen.getByRole("button", { name: f.applyAll })).toHaveFocus();
  await userEvent.keyboard("{Control>}b{/Control}");
  expect(check(2)).not.toBeChecked();
  expect(check(1)).toBeChecked();
  value(1).focus();
  await userEvent.click(screen.getByRole("button", { name: f.export }));
  await userEvent.keyboard("{Control>}b{/Control}");
  expect(check(1)).not.toBeChecked();
  expect(check(2)).not.toBeChecked();
});

test("remove_needs_its_row: Ctrl+Shift+I from Apply All or another footer button removes nothing (it could re-run the query) (#102)", async () => {
  await twoRows();
  await userEvent.click(screen.getByRole("button", { name: f.applyAll }));
  expect(onApply).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Control>}{Shift>}I{/Shift}{/Control}");
  await userEvent.click(screen.getByRole("button", { name: f.export }));
  await userEvent.keyboard("{Control>}{Shift>}I{/Shift}{/Control}");
  expect(screen.getAllByRole("checkbox", { name: /^Use condition/ })).toHaveLength(2);
  expect(onApply).toHaveBeenCalledTimes(1);
  // In its row it removes that row (applied: the other one is applied again).
  value(2).focus();
  await userEvent.keyboard("{Control>}{Shift>}I{/Shift}{/Control}");
  expect(screen.getAllByRole("checkbox", { name: /^Use condition/ })).toHaveLength(1);
  expect(onApply).toHaveBeenLastCalledWith([eq("status", "paid")], "and");
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
  // − before + (#103).
  await user.tab();
  expect(screen.getByRole("button", { name: f.removeRow(1) })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: f.addAfter(1) })).toHaveFocus();
  // Then the footer: ⚙, Export, SQL, Clear, Apply All, its ⌄.
  for (const name of [f.options, f.export, f.sql, f.clear, f.applyAll, f.combineButton("AND")]) {
    await user.tab();
    expect(screen.getByRole("button", { name }), name).toHaveFocus();
  }
  for (let i = 0; i < 12; i++) await user.tab({ shift: true });
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

test("escape_hides_the_bar: Escape hides the bar, typed or applied (#103); a menu or the SQL preview takes it first", async () => {
  const { rerender } = setup({ focusSeq: 1 });
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.type(value(1), "x");
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
  rerender(ui({ filters: [eq("id", "1")] }));
  value(1).focus();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(3);
  // In a menu, Escape closes the menu only and gives the focus back to its button.
  await userEvent.click(screen.getByRole("button", { name: f.options }));
  expect(screen.getByRole("menu", { name: f.optionsMenu })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: f.options })).toHaveFocus();
  expect(onClose).toHaveBeenCalledTimes(3);
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
  expect(joinButton("OR")).toBeInTheDocument();
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
  await applyAllWith("OR");
  expect(screen.getByRole("alert")).toHaveTextContent(f.rawOrNeedsSql);
  expect(onApply).not.toHaveBeenCalled();
  // Refused: the join stays AND (what is applied), so the row still reads as filter syntax.
  expect(joinButton("AND")).toBeInTheDocument();
  expect(reading()).toHaveTextContent(f.rawRead.bound);
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
  await applyAllWith("OR");
  expect(joinButton("OR")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: f.applyRow(1) }));
  expect(onApply).toHaveBeenLastCalledWith([eq("status", "paid")], "and");
  expect(joinButton("AND")).toBeInTheDocument();
  // The row's Apply names its key as the platform writes it.
  const apply = screen.getByRole("button", { name: f.applyRow(1) });
  expect(apply).toHaveAttribute("data-tooltip", f.applyRow(1));
  expect(apply).toHaveAttribute("data-tooltip-key", formatShortcut("Enter"));
});

test("filter_row_layout: [✓] [column] [operator] [value…] [Apply] [−] [+]; the footer [⚙] [Export] [SQL] hints [Clear] [Apply All ⌄]", () => {
  setup();
  const row = rowGroup(1);
  const names = [...row.querySelectorAll("input, select, button")].map((el) => el.getAttribute("aria-label"));
  expect(names).toEqual([
    f.enabledLabel(1),
    f.columnLabel(1),
    f.opLabel(1),
    f.valueLabel(1),
    f.applyRow(1),
    f.removeRow(1),
    f.addAfter(1),
  ]);
  // The value takes the remaining width.
  expect(value(1)).toHaveClass("flex-1");
  const buttons = within(footer())
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(buttons).toEqual([f.options, f.export, f.sql, f.clear, f.applyAll, f.combineButton("AND")]);
  // The hints sit between SQL and Clear.
  const hints = within(footer()).getByTestId("filter-hints");
  expect(screen.getByRole("button", { name: f.sql }).compareDocumentPosition(hints)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(hints.compareDocumentPosition(screen.getByRole("button", { name: f.clear }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  // Apply All and its ⌄ are no longer on the rows.
  expect(within(row).queryByRole("button", { name: f.applyAll })).toBeNull();
});

test("hint_line_follows_the_keymap: built from the effective shortcuts, a rebinding shows at once", () => {
  setup();
  const hints = within(footer()).getByTestId("filter-hints");
  for (const text of [
    f.hint(f.hints.show, "Ctrl+F"),
    f.hint(f.hints.hide, "Esc"),
    f.hint(f.hints.insert, "Ctrl+I"),
    f.hint(f.hints.remove, "Ctrl+Shift+I"),
    f.hint(f.hints.toggle, "Ctrl+B"),
    f.hint(f.hints.applyAll, "Ctrl+Enter"),
    f.hint(f.hints.up, "Ctrl+↑"),
    f.hint(f.hints.down, "Ctrl+↓"),
    f.hint(f.hints.column, "Alt+C"),
    f.hint(f.hints.operator, "Alt+O"),
  ]) {
    expect(hints, text).toHaveTextContent(text);
  }
  // The whole line is its tooltip (it is cut when the bar is narrow).
  expect(hints).toHaveAttribute("data-tooltip", hints.textContent);
  act(() =>
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "filters.add": "Alt+N", "grid.filters": "Alt+S" } } }),
  );
  expect(hints).toHaveTextContent(f.hint(f.hints.insert, "Alt+N"));
  expect(hints).toHaveTextContent(f.hint(f.hints.show, "Alt+S"));
  expect(hints).not.toHaveTextContent(f.hint(f.hints.insert, "Ctrl+I"));
});

test("filter_row_navigation: Ctrl+↑ / Ctrl+↓ move between rows on the same field; Alt+C / Alt+O jump to the column and operator", async () => {
  await twoRows();
  value(1).focus();
  await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
  expect(value(2)).toHaveFocus();
  // The last row: nowhere further.
  await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
  expect(value(2)).toHaveFocus();
  await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
  expect(value(1)).toHaveFocus();
  column(2).focus();
  await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
  expect(column(1)).toHaveFocus();
  // Jumps within the row, from any of its fields.
  value(2).focus();
  await userEvent.keyboard("{Alt>}c{/Alt}");
  expect(column(2)).toHaveFocus();
  await userEvent.keyboard("{Alt>}o{/Alt}");
  expect(op(2)).toHaveFocus();
  // A Raw SQL row has no operator: the jump lands on its SQL field.
  await userEvent.selectOptions(column(1), f.rawSql);
  column(1).focus();
  await userEvent.keyboard("{Alt>}o{/Alt}");
  expect(screen.getByRole("textbox", { name: f.rawLabel(1) })).toHaveFocus();
  // None of these keys reaches the table tab.
  const outer = vi.fn();
  window.addEventListener("keydown", outer);
  onTestFinished(() => window.removeEventListener("keydown", outer));
  await userEvent.keyboard("{Control>}{ArrowDown}{/Control}{Alt>}c{/Alt}");
  expect(outer.mock.calls.some(([e]) => ["ArrowDown", "KeyC"].includes((e as KeyboardEvent).code))).toBe(false);
});

test("clear_removes_all_filters: Clear applies no filter and leaves one blank row, focused", async () => {
  setup({ filters: [eq("status", "paid"), eq("id", "1")], combine: "or" });
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: f.clear }));
  expect(onApply).toHaveBeenLastCalledWith([], "or");
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(value(1)).toHaveValue("");
  expect(column(1)).toHaveFocus();
  expect(screen.getByRole("button", { name: f.clear })).toHaveAttribute("data-tooltip", f.clearTitle);
});

test("export_is_disabled_with_a_tooltip: focusable, says why, does nothing", async () => {
  setup();
  const exp = screen.getByRole("button", { name: f.export });
  expect(exp).toHaveAttribute("aria-disabled", "true");
  expect(exp).toHaveAttribute("data-tooltip", f.exportUnavailable);
  expect(exp).toHaveAccessibleDescription(f.exportUnavailable);
  await userEvent.click(exp);
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("sql_preview: SQL shows the WHERE of the checked rows with the values written in, read-only; Escape returns to SQL", async () => {
  await twoRows();
  previewSql.mockResolvedValue({
    sql: 'WHERE "status" = $1 AND "total" > CAST($2::text AS numeric)',
    display: `WHERE "status" = 'it''s paid' AND "total" > CAST('5'::text AS numeric)`,
  });
  const sql = screen.getByRole("button", { name: f.sql });
  expect(sql).toHaveAttribute("aria-haspopup", "dialog");
  await userEvent.click(sql);
  const dialog = await screen.findByRole("dialog", { name: f.sqlPreviewLabel });
  expect(previewSql).toHaveBeenLastCalledWith([eq("status", "paid"), { column: "total", op: "gt", values: ["5"] }], "and");
  // The display text (#109): the values as literals, not the placeholders.
  const code = await within(dialog).findByText(`WHERE "status" = 'it''s paid' AND "total" > CAST('5'::text AS numeric)`);
  expect(within(dialog).queryByText(/\$1/)).toBeNull();
  // Read-only, reachable by keyboard, with the note on values.
  expect(code.tagName).toBe("PRE");
  expect(code).toHaveFocus();
  expect(within(dialog).getByText(f.sqlParams)).toBeInTheDocument();
  expect(sql).toHaveAttribute("aria-expanded", "true");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sql).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();
  // Unchecked rows are left out; with nothing left, no clause.
  await userEvent.click(check(1));
  await userEvent.click(check(2));
  previewSql.mockResolvedValue(none);
  await userEvent.click(sql);
  expect(previewSql).toHaveBeenLastCalledWith([], "and");
  expect(await within(screen.getByRole("dialog")).findByText(f.sqlNone)).toBeInTheDocument();
});

test("sql_preview copy: Copy puts the text shown (values written in) on the clipboard", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  setup({ filters: [eq("id", "1")] });
  previewSql.mockResolvedValue({ sql: 'WHERE "id" = $1', display: `WHERE "id" = '1'` });
  await user.click(screen.getByRole("button", { name: f.sql }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(`WHERE "id" = '1'`);
  await user.click(within(dialog).getByRole("button", { name: f.sqlCopy }));
  expect(writeText).toHaveBeenCalledWith(`WHERE "id" = '1'`);
  expect(await within(dialog).findByText(f.sqlCopied)).toBeInTheDocument();
  writeText.mockRejectedValue(new Error("denied"));
  await user.click(within(dialog).getByRole("button", { name: f.sqlCopy }));
  expect(await within(dialog).findByText(f.sqlCopyFailed)).toBeInTheDocument();
});

test("sql_preview errors: a backend refusal, or rows to fix first (nothing asked)", async () => {
  setup();
  await userEvent.selectOptions(column(1), "id");
  await userEvent.type(value(1), "1");
  previewSql.mockRejectedValue({ kind: "invalid", message: "unknown column" });
  await userEvent.click(screen.getByRole("button", { name: f.sql }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(f.sqlFailed("unknown column"));
  await userEvent.click(within(dialog).getByRole("button", { name: f.sqlClose }));
  expect(screen.getByRole("button", { name: f.sql })).toHaveFocus();
  previewSql.mockClear();
  await userEvent.selectOptions(op(1), "IN");
  await userEvent.type(screen.getByRole("textbox", { name: f.listLabel(1) }), "1,,2");
  await userEvent.click(screen.getByRole("button", { name: f.sql }));
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(f.sqlRowErrors);
  expect(previewSql).not.toHaveBeenCalled();
});

test("options_menu: ⚙ lists the row actions with their keys; arrows move, a choice acts on the row last focused", async () => {
  const user = userEvent.setup();
  await twoRows();
  value(1).focus();
  await user.click(screen.getByRole("button", { name: f.options }));
  const menu = screen.getByRole("menu", { name: f.optionsMenu });
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((i) => i.getAttribute("aria-label") ?? i.textContent)).toEqual([
    f.addAfter(1),
    f.removeRow(1),
    f.toggleRow(1),
    f.clearAll,
    f.hide,
  ]);
  expect(items[0]).toHaveFocus();
  expect(items[0]).toHaveAttribute("aria-keyshortcuts", "Control+I");
  expect(items[0]).toHaveTextContent("Ctrl+I");
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(items[2]).toHaveFocus();
  await user.keyboard("{End}");
  expect(items[4]).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(items[0]).toHaveFocus();
  await user.keyboard("{Home}{ArrowDown}{ArrowDown}{Enter}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(check(1)).not.toBeChecked();
  expect(check(2)).toBeChecked();
  // Add: a row after the row, focused.
  await user.click(screen.getByRole("button", { name: f.options }));
  await user.click(screen.getByRole("menuitem", { name: f.addAfter(1) }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  expect(column(2)).toHaveFocus();
  // Hide closes the bar.
  await user.click(screen.getByRole("button", { name: f.options }));
  await user.click(screen.getByRole("menuitem", { name: f.hide }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the ⌄ menu: AND / OR as radio items with their keys, the current join checked", async () => {
  const user = userEvent.setup();
  await twoRows();
  await user.click(joinButton("AND"));
  const menu = screen.getByRole("menu", { name: f.combineMenu });
  const [and, or] = within(menu).getAllByRole("menuitemradio");
  expect(and).toHaveAttribute("aria-checked", "true");
  expect(or).toHaveAttribute("aria-checked", "false");
  expect(and).toHaveFocus();
  expect(or).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Enter");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onApply).toHaveBeenLastCalledWith([eq("status", "paid"), { column: "total", op: "gt", values: ["5"] }], "or");
  expect(joinButton("OR")).toHaveFocus();
  // A press outside closes it without choosing.
  await user.click(joinButton("OR"));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  await user.click(value(1));
  expect(screen.queryByRole("menu")).toBeNull();
});

test("a refused Apply All keeps the join it had: the ⌄, the preview and Clear still use AND (review #103)", async () => {
  await twoRows();
  onApply.mockReturnValue(false);
  await applyAllWith("OR");
  expect(onApply).toHaveBeenLastCalledWith(expect.anything(), "or");
  expect(joinButton("AND")).toBeInTheDocument();
  value(1).focus();
  await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
  expect(joinButton("AND")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: f.sql }));
  expect(previewSql).toHaveBeenLastCalledWith(expect.anything(), "and");
  await userEvent.keyboard("{Escape}");
  onApply.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: f.clear }));
  expect(onApply).toHaveBeenLastCalledWith([], "and");
});

test("hiding the bar closes its SQL preview and menus: they do not come back when it reopens (review #103)", async () => {
  previewSql.mockResolvedValue({ sql: 'WHERE "id" = $1', display: `WHERE "id" = '1'` });
  const { rerender } = setup({ filters: [eq("id", "1")] });
  await userEvent.click(screen.getByRole("button", { name: f.sql }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  // Ctrl+F from inside the preview hides the bar (the parent sets open = false).
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(onClose).toHaveBeenCalledTimes(1);
  rerender(ui({ open: false, filters: [eq("id", "1")] }));
  expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  rerender(ui({ open: true, filters: [eq("id", "1")] }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: f.sql })).toHaveAttribute("aria-expanded", "false");
  // An open menu too.
  await userEvent.click(screen.getByRole("button", { name: f.options }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  rerender(ui({ open: false, filters: [eq("id", "1")] }));
  rerender(ui({ open: true, filters: [eq("id", "1")] }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: f.options })).toHaveAttribute("aria-expanded", "false");
});

test("the ⚙ menu's Hide names Escape as the hint line does", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: f.options }));
  const hide = screen.getByRole("menuitem", { name: f.hide });
  expect(hide).toHaveTextContent("Esc");
  expect(hide).not.toHaveTextContent("Escape");
  expect(hide).toHaveAttribute("aria-keyshortcuts", "Escape");
});

test("tooltip_escape: Escape on a shown tooltip closes the tooltip only, not the bar nor the SQL preview (#109)", async () => {
  const user = userEvent.setup();
  previewSql.mockResolvedValue({ sql: 'WHERE "id" = $1', display: `WHERE "id" = '1'` });
  render(
    <>
      <TooltipLayer />
      {ui({ filters: [eq("id", "1")] })}
    </>,
  );
  // The keys go to the bar (a value field has the focus); the pointer rests on Clear.
  act(() => value(1).focus());
  const clear = screen.getByRole("button", { name: f.clear });
  await user.hover(clear);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(f.clearTitle);
  expect(clear).toHaveAccessibleDescription(f.clearTitle);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  // Without a tooltip, Escape hides the bar as before.
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);

  // Over the open SQL preview: the first Escape takes the tooltip, the next the preview.
  const sql = screen.getByRole("button", { name: f.sql });
  await user.click(sql);
  const dialog = await screen.findByRole("dialog", { name: f.sqlPreviewLabel });
  await within(dialog).findByText(`WHERE "id" = '1'`);
  await user.unhover(sql);
  await user.hover(clear);
  await screen.findByRole("tooltip");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onClose).toHaveBeenCalledTimes(1);
});
