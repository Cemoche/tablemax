import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const setup = () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Discard?"
      message="Discard 2 pending changes?"
      confirmLabel="Discard"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
};

test("confirm and cancel", async () => {
  const { onConfirm, onCancel } = setup();
  expect(screen.getByRole("dialog", { name: "Discard?" })).toHaveTextContent("Discard 2 pending changes?");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

test("Escape cancels", async () => {
  const { onConfirm, onCancel } = setup();
  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});
