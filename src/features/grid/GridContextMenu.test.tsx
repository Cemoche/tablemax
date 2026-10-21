import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { GridContextMenu, joinMenuGroups } from "./GridContextMenu";

const setup = () => {
  const onClose = vi.fn();
  const a = vi.fn();
  render(
    <div>
      <button type="button">outside</button>
      <GridContextMenu
        x={10}
        y={20}
        label="Row actions"
        items={[
          { label: "Set NULL", onSelect: a },
          "separator",
          { label: "Not here", disabled: true, onSelect: vi.fn() },
        ]}
        onClose={onClose}
      />
    </div>,
  );
  return { onClose, a };
};

test("choosing an item runs it and closes the menu", async () => {
  const { onClose, a } = setup();
  expect(screen.getByRole("menu", { name: "Row actions" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Not here" })).toBeDisabled();
  await userEvent.click(screen.getByRole("menuitem", { name: "Set NULL" }));
  expect(a).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test("Escape and a click outside close the menu", async () => {
  const { onClose, a } = setup();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "outside" }));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(a).not.toHaveBeenCalled();
});

test("joinMenuGroups puts one separator between non-empty groups", () => {
  const a = { label: "a", onSelect: () => {} };
  const b = { label: "b", onSelect: () => {} };
  expect(joinMenuGroups([[], [a], [], [b, a]])).toEqual([a, "separator", b, a]);
  expect(joinMenuGroups([[], []])).toEqual([]);
});

test("headings group items; arrows move between items, Escape closes", async () => {
  const onClose = vi.fn();
  const csv = vi.fn();
  render(
    <GridContextMenu
      x={10}
      y={20}
      label="Cell actions"
      items={[
        { label: "Quick Look", onSelect: vi.fn() },
        { heading: "Copy rows as" },
        { label: "TSV", ariaLabel: "Copy rows as TSV", onSelect: vi.fn(), indent: true },
        { label: "CSV", ariaLabel: "Copy rows as CSV", onSelect: csv, indent: true },
      ]}
      onClose={onClose}
    />,
  );
  expect(screen.getByText("Copy rows as")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Quick Look" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Copy rows as CSV" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Quick Look" })).toHaveFocus();
  await userEvent.keyboard("{End}{Enter}");
  expect(csv).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledWith("item");
});

test("highlighted_row_contrast: hovered / focused rows are --accent-strong, the shortcut hint opaque there (#107)", () => {
  render(
    <GridContextMenu
      x={10}
      y={20}
      label="Cell actions"
      items={[{ label: "Copy", shortcut: "Mod+C", onSelect: vi.fn() }]}
      onClose={vi.fn()}
    />,
  );
  const item = screen.getByRole("menuitem", { name: "Copy" });
  expect(item).toHaveClass("group", "hover:bg-accent-strong", "focus-visible:bg-accent-strong", "hover:text-accent-contrast");
  expect(item.className).not.toMatch(/(^|\s)(hover|focus-visible):bg-accent(\s|$)/);
  const hint = item.querySelector("[aria-hidden='true']");
  expect(hint).toHaveClass("opacity-70", "group-enabled:group-hover:opacity-100", "group-focus-visible:opacity-100");
});
