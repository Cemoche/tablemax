import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import { ConfirmRunDialog } from "./ConfirmRunDialog";

const stmts = ["select 1", "delete from t", "select 2"];

const setup = () => {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmRunDialog
      connectionName="Shop DB"
      envTag="prod"
      statements={stmts}
      flagged={[1]}
      onRun={onRun}
      onCancel={onCancel}
    />,
  );
  return { onRun, onCancel };
};

test("is a modal dialog listing every statement with the flagged ones marked", () => {
  setup();
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveTextContent("Shop DB");
  expect(dialog).toHaveTextContent("PROD");
  const items = screen.getAllByRole("listitem");
  expect(items.map((i) => i.textContent)).toEqual([
    expect.stringContaining("select 1"),
    expect.stringContaining("delete from t"),
    expect.stringContaining("select 2"),
  ]);
  expect(items[1]).toHaveAttribute("data-flagged", "true");
  expect(items[1]).toHaveTextContent(strings.safety.needsConfirmation);
  expect(items[0]).not.toHaveAttribute("data-flagged");
  expect(items[1].className).toContain("warning");
});

test("Cancel has the initial focus and Enter on it runs nothing", async () => {
  const { onRun, onCancel } = setup();
  const cancel = screen.getByRole("button", { name: strings.safety.confirmCancel });
  expect(cancel).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onRun).not.toHaveBeenCalled();
});

test("Escape cancels", async () => {
  const { onRun, onCancel } = setup();
  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onRun).not.toHaveBeenCalled();
});

test("Run confirms", async () => {
  const { onRun, onCancel } = setup();
  await userEvent.click(screen.getByRole("button", { name: strings.safety.confirmRun }));
  expect(onRun).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});
