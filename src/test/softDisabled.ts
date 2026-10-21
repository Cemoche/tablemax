import { act, screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { expect } from "vitest";

/**
 * Checks a button that is off by `softDisabled` (#110): not natively disabled but
 * `aria-disabled`, its tooltip shows on hover and on keyboard focus (the test renders a
 * `TooltipLayer`), and a click, Enter and Space do nothing (`acted` stays false).
 */
export async function expectSoftDisabled(
  user: UserEvent,
  button: HTMLElement,
  tooltip: string,
  acted: () => boolean,
): Promise<void> {
  expect(button).not.toBeDisabled();
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAttribute("data-tooltip", tooltip);

  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(tooltip);
  await user.unhover(button);
  expect(screen.queryByRole("tooltip")).toBeNull();

  // Keyboard focus reaches it (Tab), and shows its tooltip at once.
  if (document.activeElement === button) act(() => button.blur());
  for (let i = 0; i < 80 && document.activeElement !== button; i++) await user.tab();
  expect(button).toHaveFocus();
  expect(screen.getByRole("tooltip")).toHaveTextContent(tooltip);

  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  await user.click(button);
  expect(acted()).toBe(false);
}
