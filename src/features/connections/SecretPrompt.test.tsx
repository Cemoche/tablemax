import { expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecretPrompt } from "./SecretPrompt";

test("each variant has its own title and label, and focuses the field", () => {
  const { rerender } = render(
    <SecretPrompt kind="password" connectionName="Prod" onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  expect(screen.getByRole("dialog", { name: "Password required" })).toBeInTheDocument();
  expect(screen.getByLabelText("Password")).toHaveFocus();

  rerender(<SecretPrompt kind="sshPassword" connectionName="Prod" onSubmit={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "SSH password required" })).toBeInTheDocument();
  expect(screen.getByLabelText("SSH password")).toBeInTheDocument();

  rerender(<SecretPrompt kind="sshPassphrase" connectionName="Prod" onSubmit={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Key passphrase required" })).toBeInTheDocument();
  expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();
});

test("submits the typed secret and shows the error", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(
    <SecretPrompt kind="sshPassphrase" connectionName="Prod" error="Wrong" onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
  expect(screen.getByText("Wrong")).toBeInTheDocument();
  await user.type(screen.getByLabelText("Passphrase"), "pp{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("pp");
});

test("Escape cancels", () => {
  const onCancel = vi.fn();
  render(<SecretPrompt kind="password" connectionName="Prod" onSubmit={vi.fn()} onCancel={onCancel} />);
  // Taken (default prevented): the connection form behind ignores this press (#118).
  expect(fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })).toBe(false);
  expect(onCancel).toHaveBeenCalledTimes(1);
});
