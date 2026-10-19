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
