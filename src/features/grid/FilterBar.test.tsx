import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import type { Dialect, Filter } from "../../lib/types";
import { FilterBar } from "./FilterBar";

const cols = ["status", "total", "id", "notes"];
let onApply: ReturnType<typeof vi.fn<(f: Filter[]) => boolean>>;

beforeEach(() => {
  onApply = vi.fn<(f: Filter[]) => boolean>(() => true);
});

const setup = (filters: Filter[] = [], dialect: Dialect = "postgres") =>
  render(<FilterBar dialect={dialect} columns={cols} filters={filters} onApply={onApply} />);
const quick = () => screen.getByRole("textbox", { name: strings.filters.quickLabel });
const optionValues = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);
const openBuilder = () => userEvent.click(screen.getByRole("button", { name: strings.filters.button(0) }));

test("typing a quick filter and pressing Enter applies it", async () => {
  setup();
  await userEvent.type(quick(), "status = paid and total > 100{Enter}");
  expect(onApply).toHaveBeenCalledWith([
    { column: "status", op: "eq", values: ["paid"] },
    { column: "total", op: "gt", values: ["100"] },
  ]);
});

test("a syntax error shows under the field and applies nothing; Escape cancels", async () => {
  setup([{ column: "id", op: "eq", values: ["1"] }]);
  expect(quick()).toHaveValue("id = 1");
  await userEvent.clear(quick());
  await userEvent.type(quick(), "nope = 1{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent('unknown column "nope"');
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.type(quick(), "{Escape}");
  expect(quick()).toHaveValue("id = 1");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an empty quick filter clears the filters", async () => {
  setup([{ column: "id", op: "eq", values: ["1"] }]);
  await userEvent.clear(quick());
  await userEvent.type(quick(), "{Enter}");
  expect(onApply).toHaveBeenCalledWith([]);
});

test("a refused apply keeps the typed text", async () => {
  onApply.mockReturnValue(false);
  setup();
  await userEvent.type(quick(), "id = 7{Enter}");
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(quick()).toHaveValue("id = 7");
});

test("the builder offers ILIKE on PostgreSQL only", async () => {
  const { unmount } = setup([], "mySql");
  await openBuilder();
  expect(optionValues(screen.getByRole("combobox", { name: strings.filters.opLabel(1) }))).not.toContain(
    strings.filters.ops.ilike,
  );
  expect(optionValues(screen.getByRole("combobox", { name: strings.filters.opLabel(1) }))).toContain(
    strings.filters.ops.like,
  );
  unmount();
  setup([], "postgres");
  await openBuilder();
  expect(optionValues(screen.getByRole("combobox", { name: strings.filters.opLabel(1) }))).toContain(
    strings.filters.ops.ilike,
  );
});

test("Any column limits the operators", async () => {
  setup();
  await openBuilder();
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: strings.filters.columnLabel(1) }),
    strings.filters.anyColumn,
  );
  expect(optionValues(screen.getByRole("combobox", { name: strings.filters.opLabel(1) }))).toEqual([
    strings.filters.ops.eq,
    strings.filters.ops.contains,
    strings.filters.ops.notContains,
    strings.filters.ops.like,
  ]);
});

test("the builder applies its rows, with value fields per operator", async () => {
  setup();
  await openBuilder();
  const op1 = screen.getByRole("combobox", { name: strings.filters.opLabel(1) });
  await userEvent.selectOptions(op1, strings.filters.ops.in);
  await userEvent.type(screen.getByRole("textbox", { name: strings.filters.listLabel(1) }), "paid, 'a, b'");
  await userEvent.click(screen.getByRole("button", { name: strings.filters.addRow }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: strings.filters.columnLabel(2) }), "total");
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: strings.filters.opLabel(2) }),
    strings.filters.ops.between,
  );
  await userEvent.type(screen.getByRole("textbox", { name: strings.filters.valueLabel(2) }), "1");
  await userEvent.type(screen.getByRole("textbox", { name: strings.filters.secondValueLabel(2) }), "9");
  await userEvent.click(screen.getByRole("button", { name: strings.filters.addRow }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: strings.filters.columnLabel(3) }), "notes");
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: strings.filters.opLabel(3) }),
    strings.filters.ops.isNull,
  );
  expect(screen.queryByRole("textbox", { name: strings.filters.valueLabel(3) })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: strings.filters.apply }));
  expect(onApply).toHaveBeenCalledWith([
    { column: "status", op: "in", values: ["paid", "a, b"] },
    { column: "total", op: "between", values: ["1", "9"] },
    { column: "notes", op: "isNull", values: [] },
  ]);
});

test("a builder row error blocks Apply; – removes the row", async () => {
  setup();
  await openBuilder();
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: strings.filters.opLabel(1) }),
    strings.filters.ops.in,
  );
  await userEvent.type(screen.getByRole("textbox", { name: strings.filters.listLabel(1) }), "1,,2");
  await userEvent.click(screen.getByRole("button", { name: strings.filters.apply }));
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/empty value/);
  await userEvent.click(screen.getByRole("button", { name: strings.filters.removeRow(1) }));
  await userEvent.click(screen.getByRole("button", { name: strings.filters.apply }));
  expect(onApply).toHaveBeenCalledWith([]);
});

test("Clear empties the filters", async () => {
  setup([{ column: "id", op: "eq", values: ["1"] }]);
  await userEvent.click(screen.getByRole("button", { name: strings.filters.button(1) }));
  await userEvent.click(screen.getByRole("button", { name: strings.filters.clear }));
  expect(onApply).toHaveBeenCalledWith([]);
});

test("bar and builder follow the applied filters; raw SQL shows the advanced badge", async () => {
  const { rerender } = setup();
  await openBuilder();
  const next: Filter[] = [
    { column: "status", op: "eq", values: ["paid"] },
    { column: null, op: "raw", values: ["total > 2 * id"] },
  ];
  rerender(<FilterBar dialect="postgres" columns={cols} filters={next} onApply={onApply} />);
  expect(quick()).toHaveValue("status = paid AND (total > 2 * id)");
  expect(screen.getByText(strings.filters.advanced)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: strings.filters.button(2) })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: strings.filters.columnLabel(2) })).toHaveDisplayValue(
    strings.filters.rawSql,
  );
  expect(screen.getByRole("textbox", { name: strings.filters.rawLabel(2) })).toHaveValue("total > 2 * id");
  // Enter on the unchanged (unparseable) text changes nothing.
  await userEvent.type(quick(), "{Enter}");
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});
