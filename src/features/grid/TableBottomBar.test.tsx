import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import { useGridViews } from "../../stores/gridViews";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { type BottomBarData, TableBottomBar } from "./TableBottomBar";

const g = strings.grid;

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useGridViews.setState({ views: {}, trails: {}, layouts: {} });
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
});

function data(over: Partial<BottomBarData> = {}): BottomBarData {
  return {
    addRow: { onClick: vi.fn(), disabled: false, ref: createRef() },
    counter: "1–300 of 1,250 rows",
    busy: false,
    filters: { open: false, count: 0, controls: "fb", onToggle: vi.fn(), ref: createRef() },
    columns: { names: ["id", "note"], layoutKey: "k", open: false, onOpenChange: vi.fn() },
    paging: {
      hasPrev: false,
      hasNext: true,
      disabled: false,
      onPrev: vi.fn(),
      onNext: vi.fn(),
      offset: 0,
      limit: 300,
      onGo: vi.fn(() => true),
    },
    ...over,
  };
}

const ids = { data: "p-data", structure: "p-structure", index: "p-index" };

test("bottom_bar_layout: view switch, + Row, centered counter, Filters, Columns and pagination, in that order", () => {
  render(<TableBottomBar view="data" onView={vi.fn()} panelIds={ids} data={data()} />);
  const bar = screen.getByRole("group", { name: g.bottomBar });
  const names = [...bar.querySelectorAll('[role="tab"], button')].map(
    (el) => el.getAttribute("aria-label") ?? el.textContent,
  );
  expect(names).toEqual([
    g.view.data,
    g.view.structure,
    g.view.index,
    g.addRow,
    strings.filters.button(0),
    g.columns,
    g.prev,
    g.pageSettings,
    g.next,
  ]);
  expect(within(bar).getByText("1–300 of 1,250 rows")).toHaveAttribute("data-testid", "footer-range");
  // Shortcuts are named in tooltips and announced.
  expect(screen.getByRole("button", { name: g.addRow })).toHaveAttribute("title", g.addRowShortcut("Ctrl+I"));
  expect(screen.getByRole("button", { name: g.addRow })).toHaveAttribute("aria-keyshortcuts", "Control+I");
  expect(screen.getByRole("button", { name: strings.filters.button(0) })).toHaveAttribute(
    "title",
    g.filtersShortcut("Ctrl+F"),
  );
  expect(screen.getByRole("button", { name: g.columns })).toHaveAttribute("title", g.columnsShortcut("Alt+F"));
  expect(screen.getByRole("button", { name: g.prev })).toHaveAttribute("title", g.pageShortcut(g.prev, "Ctrl+←"));
  expect(screen.getByRole("button", { name: g.prev })).toBeDisabled();
  expect(screen.getByRole("button", { name: g.next })).toBeEnabled();
  expect(screen.getByRole("tab", { name: g.view.data })).toHaveAttribute("title", g.view.dataShortcut("Alt+1"));
  expect(screen.getByRole("tab", { name: g.view.data })).toHaveAttribute("aria-controls", ids.data);
  expect(screen.getByRole("tab", { name: g.view.index })).toHaveAttribute("title", g.view.indexShortcut("Alt+3"));
  expect(screen.getByRole("tab", { name: g.view.index })).toHaveAttribute("aria-keyshortcuts", "Alt+3");
  expect(screen.getByRole("tab", { name: g.view.index })).toHaveAttribute("aria-controls", ids.index);
});

test("the Filters button says how many filters apply and whether the bar is open", () => {
  render(
    <TableBottomBar
      view="data"
      onView={vi.fn()}
      panelIds={ids}
      data={data({ filters: { open: true, count: 2, controls: "fb", onToggle: vi.fn(), ref: createRef() } })}
    />,
  );
  const button = screen.getByRole("button", { name: strings.filters.button(2) });
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(button).toHaveAttribute("aria-controls", "fb");
});

test("a read-only table has no + Row; the structure view shows only the view switch", () => {
  const { rerender } = render(
    <TableBottomBar view="data" onView={vi.fn()} panelIds={ids} data={data({ addRow: undefined })} />,
  );
  expect(screen.queryByRole("button", { name: g.addRow })).toBeNull();
  rerender(<TableBottomBar view="structure" onView={vi.fn()} panelIds={ids} data={null} />);
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  expect(screen.queryByRole("button")).toBeNull();
});

test("the view switch is one Tab stop; arrows, Home and End move between Data, Structure and Index", async () => {
  const onView = vi.fn();
  const { rerender } = render(<TableBottomBar view="data" onView={onView} panelIds={ids} data={data()} />);
  const dataTab = screen.getByRole("tab", { name: g.view.data });
  const structureTab = screen.getByRole("tab", { name: g.view.structure });
  expect(dataTab).toHaveAttribute("tabindex", "0");
  expect(structureTab).toHaveAttribute("tabindex", "-1");
  dataTab.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onView).toHaveBeenLastCalledWith("structure");
  rerender(<TableBottomBar view="structure" onView={onView} panelIds={ids} data={null} />);
  expect(structureTab).toHaveFocus();
  await userEvent.keyboard("{Home}");
  expect(onView).toHaveBeenLastCalledWith("data");
  rerender(<TableBottomBar view="data" onView={onView} panelIds={ids} data={data()} />);
  expect(dataTab).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(onView).toHaveBeenLastCalledWith("index");
  rerender(<TableBottomBar view="index" onView={onView} panelIds={ids} data={null} />);
  expect(screen.getByRole("tab", { name: g.view.index })).toHaveFocus();
  // Right from the last view wraps to the first.
  await userEvent.keyboard("{ArrowRight}");
  expect(onView).toHaveBeenLastCalledWith("data");
});

test("buttons act: + Row, Filters, pages; the page popover goes to an offset; Columns opens its popover", async () => {
  const d = data({ paging: { ...data().paging, hasPrev: true } });
  const { rerender } = render(<TableBottomBar view="data" onView={vi.fn()} panelIds={ids} data={d} />);
  await userEvent.click(screen.getByRole("button", { name: g.addRow }));
  expect(d.addRow!.onClick).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: strings.filters.button(0) }));
  expect(d.filters.onToggle).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: g.prev }));
  await userEvent.click(screen.getByRole("button", { name: g.next }));
  expect(d.paging.onPrev).toHaveBeenCalled();
  expect(d.paging.onNext).toHaveBeenCalled();
  const settings = screen.getByRole("button", { name: g.pageSettings });
  expect(settings).toHaveAttribute("aria-haspopup", "dialog");
  await userEvent.click(settings);
  expect(settings).toHaveAttribute("aria-expanded", "true");
  const limit = screen.getByRole("textbox", { name: g.pagePopover.limit });
  await userEvent.clear(limit);
  await userEvent.type(limit, "50{Enter}");
  expect(d.paging.onGo).toHaveBeenCalledWith(0, 50);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(settings).toHaveFocus();
  // Columns: the parent owns its open state (Alt+F opens it too).
  await userEvent.click(screen.getByRole("button", { name: g.columns }));
  expect(d.columns.onOpenChange).toHaveBeenCalledWith(true);
  rerender(
    <TableBottomBar
      view="data"
      onView={vi.fn()}
      panelIds={ids}
      data={{ ...d, columns: { ...d.columns, open: true } }}
    />,
  );
  expect(screen.getByRole("dialog", { name: g.columnsPopover.label })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(d.columns.onOpenChange).toHaveBeenLastCalledWith(false);
});
