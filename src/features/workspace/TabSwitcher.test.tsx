import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
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
  status: "connected",
  database: null,
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
  useSettings.setState({ settings: DEFAULT_SETTINGS });
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

test("custom next/previous combinations cycle while their modifier is held; Ctrl+Tab no longer does", () => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, keymap: { "tab.next": "Alt+Q", "tab.previous": "Alt+Shift+Q" } },
  });
  render(<TabSwitcher workspace={workspace} />);
  ctrlTab();
  expect(screen.queryByRole("listbox")).toBeNull();
  releaseCtrl();
  expect(active()).toBe("c");

  const altQ = (extra: KeyboardEventInit = {}) => press({ code: "KeyQ", key: "q", altKey: true, ...extra });
  altQ();
  expect(selected()).toHaveTextContent("Alpha");
  altQ();
  expect(selected()).toHaveTextContent("Beta");
  altQ({ shiftKey: true });
  expect(selected()).toHaveTextContent("Alpha");
  // Releasing another modifier does not commit; releasing Alt does.
  releaseCtrl();
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  press({ code: "AltLeft", key: "Alt" }, "keyup");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(active()).toBe("a");
});

test("a combination with no modifier to hold switches once per press, without the list", () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "tab.next": "F6", "tab.previous": "Shift+F6" } } });
  render(<TabSwitcher workspace={workspace} />);
  press({ code: "F6", key: "F6" });
  expect(screen.queryByRole("listbox")).toBeNull();
  // The most recently used other tab, as Ctrl+Tab then release would pick.
  expect(active()).toBe("a");
  press({ code: "F6", key: "F6", shiftKey: true });
  // The least recently used tab (mru is now a, c, b).
  expect(active()).toBe("b");
});
