import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { TooltipLayer } from "../features/chrome/TooltipLayer";
import { isDisabled, softDisabled } from "./softDisabled";
import { tip } from "./tooltip";

function setup(off: boolean) {
  const onClick = vi.fn();
  const onParentClick = vi.fn();
  const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  const ui = (isOff: boolean) => (
    <>
      <TooltipLayer />
      <button type="button">before</button>
      {/* A submit button in a form: off, it must not submit either. */}
      <form onSubmit={onSubmit}>
        <div onClick={onParentClick}>
          <button type="submit" aria-label="Commit" {...tip("Commit the changes", "Ctrl+S")} {...softDisabled(isOff, onClick)}>
            C
          </button>
        </div>
      </form>
    </>
  );
  const r = render(ui(off));
  return {
    button: screen.getByRole("button", { name: "Commit" }),
    onClick,
    onParentClick,
    onSubmit,
    rerender: (isOff: boolean) => r.rerender(ui(isOff)),
  };
}

test("soft_disabled: aria-disabled, still focusable; a click, Enter and Space do nothing", async () => {
  const user = userEvent.setup();
  const { button, onClick, onParentClick, onSubmit } = setup(true);
  expect(button).not.toBeDisabled();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(isDisabled(button)).toBe(true);
  await user.tab();
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  await user.click(button);
  expect(onClick).not.toHaveBeenCalled();
  expect(onParentClick).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("soft_disabled: the tooltip shows on hover and on keyboard focus", async () => {
  const user = userEvent.setup();
  const { button } = setup(true);
  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Commit the changes");
  await user.unhover(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  await user.tab();
  await user.tab();
  expect(button).toHaveFocus();
  expect(screen.getByRole("tooltip")).toHaveTextContent("Commit the changes");
});

test("soft_disabled: enabled, the button works as usual", async () => {
  const user = userEvent.setup();
  const { button, onClick, onParentClick, onSubmit, rerender } = setup(true);
  rerender(false);
  expect(button).not.toHaveAttribute("aria-disabled");
  expect(isDisabled(button)).toBe(false);
  await user.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onParentClick).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("is_disabled: native disabled counts too", () => {
  render(
    <button type="button" disabled>
      x
    </button>,
  );
  expect(isDisabled(screen.getByRole("button"))).toBe(true);
});
