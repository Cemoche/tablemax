import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
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
      safeMode="confirmWrites"
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

test("Escape cancels even after the focus fell to the body", async () => {
  const { onRun, onCancel } = setup();
  act(() => (document.activeElement as HTMLElement).blur());
  expect(document.body).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onRun).not.toHaveBeenCalled();
});

test("Escape from inside the dialog cancels once and does not reach window listeners", async () => {
  const onWindowKey = vi.fn();
  window.addEventListener("keydown", onWindowKey);
  try {
    const { onCancel } = setup();
    expect(screen.getByRole("button", { name: strings.safety.confirmCancel })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onWindowKey).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", onWindowKey);
  }
});

test("Tab keeps toggling between the two buttons", async () => {
  setup();
  const cancel = screen.getByRole("button", { name: strings.safety.confirmCancel });
  const run = screen.getByRole("button", { name: strings.safety.confirmRun });
  await userEvent.keyboard("{Tab}");
  expect(run).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  expect(cancel).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(run).toHaveFocus();
});

test("Escape stops cancelling once the dialog is gone", async () => {
  const onCancel = vi.fn();
  const { unmount } = render(
    <ConfirmRunDialog connectionName="Shop DB" envTag="prod" statements={stmts} flagged={[1]} onRun={vi.fn()} onCancel={onCancel} />,
  );
  unmount();
  await userEvent.keyboard("{Escape}");
  expect(onCancel).not.toHaveBeenCalled();
});

test("Run confirms", async () => {
  const { onRun, onCancel } = setup();
  await userEvent.click(screen.getByRole("button", { name: strings.safety.confirmRun }));
  expect(onRun).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});

test("shows the safe mode being enforced", () => {
  setup();
  expect(screen.getByRole("dialog")).toHaveTextContent("Safe mode: confirm writes");
});

test("Cancel gives the focus back to the element that had it before the dialog", async () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <textarea aria-label="editor" />
        <button onClick={() => setOpen(true)}>open</button>
        {open && (
          <ConfirmRunDialog
            connectionName="Shop DB"
            envTag="prod"
            statements={stmts}
            flagged={[1]}
            onRun={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        )}
      </>
    );
  }
  render(<Host />);
  const editor = screen.getByRole("textbox", { name: "editor" });
  editor.focus();
  act(() => screen.getByRole("button", { name: "open" }).click());
  expect(screen.getByRole("button", { name: strings.safety.confirmCancel })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: strings.safety.confirmCancel }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(editor).toHaveFocus();
});
