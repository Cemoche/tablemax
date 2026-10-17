import { expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strings } from "../../lib/strings";
import { HostKeyPrompt } from "./HostKeyPrompt";

const FP = "SHA256:abcDEF0123456789abcDEF0123456789abcDEF01234";

test("shows the host and the fingerprint in monospace", () => {
  render(<HostKeyPrompt host="127.0.0.1:2222" fingerprint={FP} onTrust={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("127.0.0.1:2222")).toBeInTheDocument();
  expect(screen.getByText(FP)).toHaveClass("font-mono");
  expect(screen.getByText(strings.ssh.unknownHostExplain)).toBeInTheDocument();
});

test("Trust and connect calls onTrust", async () => {
  const onTrust = vi.fn();
  render(<HostKeyPrompt host="h" fingerprint={FP} onTrust={onTrust} onCancel={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Trust and connect" }));
  expect(onTrust).toHaveBeenCalledTimes(1);
});

test("Escape and Cancel call onCancel", async () => {
  const onCancel = vi.fn();
  render(<HostKeyPrompt host="h" fingerprint={FP} onTrust={vi.fn()} onCancel={onCancel} />);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(2);
});
