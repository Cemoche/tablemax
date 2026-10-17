import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { TabSwitcher } from "./TabSwitcher";

const q = (id: string, title: string) =>
  ({ id, kind: "query", title, sql: "", sqlSessionId: null }) as const;

const workspace: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  schemas: ["public"],
  currentSchema: "public",
  tabs: [q("a", "Alpha"), q("b", "Beta"), q("c", "Gamma")],
  activeTabId: "c",
  mru: ["c", "a", "b"],
};

const press = (init: KeyboardEventInit, type: "keydown" | "keyup" = "keydown") =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
const ctrlTab = (extra: KeyboardEventInit = {}) =>
  press({ code: "Tab", key: "Tab", ctrlKey: true, ...extra });
const releaseCtrl = () => press({ code: "ControlLeft", key: "Control" }, "keyup");
const active = () => useWorkspaces.getState().workspaces[0].activeTabId;
const selected = () =>
  screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

beforeEach(() => {
  useWorkspaces.setState({ workspaces: [workspace], activeWorkspaceId: "w1" });
});

test("Ctrl+Tab lists tabs in mru order with the 2nd selected; releasing Ctrl activates it", () => {
  render(<TabSwitcher workspace={workspace} />);
  expect(screen.queryByRole("listbox")).toBeNull();
  ctrlTab();
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    expect.stringContaining("Gamma"),
    expect.stringContaining("Alpha"),
    expect.stringContaining("Beta"),
  ]);
  expect(selected()).toHaveTextContent("Alpha");
  releaseCtrl();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(active()).toBe("a");
});

test("each extra Tab advances (wrapping), Shift+Tab goes back, repeats are ignored", () => {
  render(<TabSwitcher workspace={workspace} />);
  ctrlTab();
  ctrlTab();
  expect(selected()).toHaveTextContent("Beta");
  ctrlTab({ repeat: true });
  expect(selected()).toHaveTextContent("Beta");
  ctrlTab();
  expect(selected()).toHaveTextContent("Gamma");
  ctrlTab({ shiftKey: true });
  expect(selected()).toHaveTextContent("Beta");
  releaseCtrl();
  expect(active()).toBe("b");
});

test("Escape cancels without activating", () => {
  render(<TabSwitcher workspace={workspace} />);
  ctrlTab();
  press({ code: "Escape", key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  releaseCtrl();
  expect(active()).toBe("c");
});

test("does nothing with a single tab or while a modal is open", () => {
  const one = { ...workspace, tabs: [q("a", "Alpha")], activeTabId: "a", mru: ["a"] };
  useWorkspaces.setState({ workspaces: [one] });
  const { rerender } = render(<TabSwitcher workspace={one} />);
  ctrlTab();
  expect(screen.queryByRole("listbox")).toBeNull();

  useWorkspaces.setState({ workspaces: [workspace] });
  rerender(<TabSwitcher workspace={workspace} />);
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.appendChild(modal);
  ctrlTab();
  expect(screen.queryByRole("listbox")).toBeNull();
  modal.remove();
});
