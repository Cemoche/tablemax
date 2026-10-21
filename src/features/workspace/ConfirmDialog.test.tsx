import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const setup = (initialFocus?: "cancel" | "confirm") => {
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
      initialFocus={initialFocus}
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

test("initial_focus: Cancel by default, Confirm with initialFocus=\"confirm\" (Enter presses it)", async () => {
  const first = setup();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  cleanup();
  expect(first.onConfirm).not.toHaveBeenCalled();
  const { onConfirm, onCancel } = setup("confirm");
  expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
});

test("danger_button_contrast: the destructive button is --danger-strong with --danger-contrast text (#128)", () => {
  setup();
  const confirm = screen.getByRole("button", { name: "Discard" });
  expect(confirm).toHaveClass("bg-danger-strong", "text-danger-contrast");
  expect(confirm).not.toHaveClass("bg-danger");
});

test("a held Escape acts once: its repeats keep the question open, a fresh press cancels", () => {
  const { onCancel } = setup();
  const dialog = screen.getByRole("dialog");
  // The repeats of the press that opened the question are taken but do nothing.
  expect(fireEvent.keyDown(dialog, { key: "Escape", repeat: true })).toBe(false);
  expect(fireEvent.keyDown(dialog, { key: "Escape", repeat: true })).toBe(false);
  expect(onCancel).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(dialog, { key: "Escape" })).toBe(false);
  expect(onCancel).toHaveBeenCalledOnce();
});
