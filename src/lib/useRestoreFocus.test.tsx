import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { useRestoreFocus } from "./useRestoreFocus";

function Dialog() {
  useRestoreFocus();
  // Like the real dialogs: a child steals the focus in its own mount effect.
  return <button autoFocus>inside</button>;
}

function Host({ open, disabled, hidden }: { open: boolean; disabled?: boolean; hidden?: boolean }) {
  return (
    <div>
      <div hidden={hidden}>
        <button disabled={disabled}>opener</button>
      </div>
      {open && <Dialog />}
    </div>
  );
}

test("focuses the element that had the focus before the dialog once it unmounts", () => {
  const { rerender } = render(<Host open={false} />);
  screen.getByRole("button", { name: "opener" }).focus();
  rerender(<Host open />);
  expect(screen.getByRole("button", { name: "inside" })).toHaveFocus();
  rerender(<Host open={false} />);
  expect(screen.getByRole("button", { name: "opener" })).toHaveFocus();
});

test("does nothing when the opener is gone, disabled or hidden", () => {
  const { rerender } = render(<Host open={false} />);
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  rerender(<Host open />);
  rerender(<Host open={false} disabled />);
  expect(opener).not.toHaveFocus();
  rerender(<Host open hidden />);
  rerender(<Host open={false} hidden />);
  expect(opener).not.toHaveFocus();
});
