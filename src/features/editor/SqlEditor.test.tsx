import { completionStatus } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { act } from "react";
import { useSettings, DEFAULT_SETTINGS } from "../../stores/settings";
import { applyTheme } from "../../lib/theme";
import { SqlEditor, buildEditorTheme, editorThemeSpec, insertAtCursor, sqlHighlightStyle } from "./SqlEditor";

// CodeMirror measures text ranges (a pick scrolls the cursor into view), which jsdom does not lay out.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

test("editor theme takes background and text from the tokens", () => {
  expect(editorThemeSpec["&"]).toMatchObject({
    backgroundColor: "var(--surface)",
    color: "var(--text)",
  });
  expect(editorThemeSpec[".cm-scroller"].backgroundColor).toBe("var(--surface)");
  expect(editorThemeSpec[".cm-content"]).toMatchObject({
    backgroundColor: "var(--surface)",
    color: "var(--text)",
  });
  expect(editorThemeSpec[".cm-gutters"].backgroundColor).toBe("var(--surface-2)");
  expect(JSON.stringify(editorThemeSpec)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  expect(buildEditorTheme(true)).toBeDefined();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});

function mount() {
  return render(<SqlEditor value="select 1" onChange={() => {}} dialect="postgres" onRun={() => {}} />);
}

test("editor follows data-theme while the OS is light", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const { container } = mount();
  const editorClass = () => container.querySelector(".cm-editor")?.className;
  const light = editorClass();
  expect(light).toBeDefined();
  await act(async () => applyTheme("dark"));
  // CodeMirror's dark base theme adds its own scoped class to the editor element.
  expect(editorClass()).not.toBe(light);
});

test("the editor font comes from CSS variables set on its container, never from built CSS", async () => {
  // Static rules: the theme never contains the user's text.
  expect(editorThemeSpec[".cm-scroller"].fontFamily).toBe("var(--editor-font-family, var(--font-mono))");
  expect(editorThemeSpec["&"].fontSize).toBe("var(--editor-font-size, var(--text-md))");
  const { container } = mount();
  const host = () => container.firstElementChild as HTMLElement;
  expect(host().style.getPropertyValue("--editor-font-family")).toBe("");
  await act(async () =>
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, editorFontSize: 20, editorFontFamily: '"Fira Code", monospace' },
    }),
  );
  expect(host().style.getPropertyValue("--editor-font-family")).toBe('"Fira Code", monospace');
  expect(host().style.getPropertyValue("--editor-font-size")).toBe("20px");
  expect(host()).toContainElement(container.querySelector(".cm-editor") as HTMLElement);
  const css = Array.from(document.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  expect(css).not.toContain("Fira Code");
});

test("an invalid font family is never applied", async () => {
  const { container } = mount();
  await act(async () =>
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, editorFontFamily: "x; } .a { color: red" },
    }),
  );
  const host = container.firstElementChild as HTMLElement;
  expect(host.style.getPropertyValue("--editor-font-family")).toBe("");
  const css = Array.from(document.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  // (CodeMirror's own base CSS has a `color: red`, so look for the injected text itself.)
  expect(css).not.toContain("x; }");
  expect(css).not.toMatch(/\.a\s*\{/);
});

test("insertAtCursor is one undo step", () => {
  const view = new EditorView({
    state: EditorState.create({ doc: "select 1;\n", selection: { anchor: 10 }, extensions: [history()] }),
  });
  insertAtCursor(view, "select 2");
  expect(view.state.doc.toString()).toBe("select 1;\nselect 2");
  expect(view.state.selection.main.head).toBe(18);
  undo(view);
  expect(view.state.doc.toString()).toBe("select 1;\n");
  // A selection is replaced by the inserted text.
  view.dispatch({ selection: { anchor: 0, head: 6 } });
  insertAtCursor(view, "SELECT");
  expect(view.state.doc.toString()).toBe("SELECT 1;\n");
  view.destroy();
});

test("run, run all, format and comment follow the keymap: a custom run combination replaces Mod+Enter", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  const onRun = vi.fn();
  const { container } = render(<SqlEditor value="select 1" onChange={() => {}} dialect="postgres" onRun={onRun} />);
  const content = container.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no editor");
  const press = (init: KeyboardEventInit & { keyCode: number }) =>
    act(() => {
      fireEvent.keyDown(view.contentDOM, init);
    });
  const ENTER = { key: "Enter", code: "Enter", keyCode: 13 };

  press({ ...ENTER, ctrlKey: true });
  expect(onRun).toHaveBeenLastCalledWith("current");
  press({ ...ENTER, ctrlKey: true, shiftKey: true });
  expect(onRun).toHaveBeenLastCalledWith("all");
  // Holding the combination runs once.
  press({ ...ENTER, ctrlKey: true, repeat: true });
  expect(onRun).toHaveBeenCalledTimes(2);
  expect(view.state.doc.toString()).toBe("select 1");

  await act(async () =>
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, keymap: { "editor.run": "Alt+Enter", "editor.comment": "Mod+Shift+7" } },
    }),
  );
  onRun.mockClear();
  press({ ...ENTER, metaKey: true });
  press({ ...ENTER, ctrlKey: true });
  expect(onRun).not.toHaveBeenCalled();
  press({ ...ENTER, altKey: true });
  expect(onRun).toHaveBeenCalledWith("current");
  press({ key: "/", code: "Slash", keyCode: 191, ctrlKey: true });
  expect(view.state.doc.toString()).not.toMatch(/^-- select 1/);
  press({ key: "&", code: "Digit7", keyCode: 55, ctrlKey: true, shiftKey: true });
  expect(view.state.doc.toString()).toMatch(/^-- select 1/);
});

test("ctrl_space_in_editor_stays_completion: Ctrl+Space in the editor opens the completion", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  const completion = vi.fn(() => ({ from: 0, options: [{ label: "select" }] }));
  const { container } = render(
    <SqlEditor value="sel" onChange={() => {}} dialect="postgres" onRun={() => {}} completionSource={completion} />,
  );
  const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement);
  if (!view) throw new Error("no editor");
  act(() => view.dispatch({ selection: { anchor: 3 } }));
  expect(completionStatus(view.state)).toBeNull();
  const event = new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    view.contentDOM.dispatchEvent(event);
  });
  // CodeMirror took it (its completion keymap) and started the completion.
  expect(event.defaultPrevented).toBe(true);
  expect(completionStatus(view.state)).not.toBeNull();
  await waitFor(() => expect(completion).toHaveBeenCalled());
});

test("editor_format_alternate: Ctrl+Shift+F formats too, in the editor's shortcut region", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  const { container } = render(<SqlEditor value="select 1" onChange={() => {}} dialect="postgres" onRun={() => {}} />);
  // The region the keymap's precedence reads (spec §5.5 #90).
  expect(container.querySelector(".cm-editor")).toHaveAttribute("data-shortcut-scope", "editor");
  const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement);
  if (!view) throw new Error("no editor");
  const event = new KeyboardEvent("keydown", {
    key: "F",
    code: "KeyF",
    keyCode: 70,
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    view.contentDOM.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(view.state.doc.toString()).toBe("SELECT\n  1"));
});

test("editor_complete_rebinds: a custom completion key replaces Ctrl+Space", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  onTestFinished(() => useSettings.setState({ settings: DEFAULT_SETTINGS }));
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "editor.complete": "Alt+Space" } } });
  const completion = vi.fn(() => ({ from: 0, options: [{ label: "select" }] }));
  const { container } = render(
    <SqlEditor value="sel" onChange={() => {}} dialect="postgres" onRun={() => {}} completionSource={completion} />,
  );
  const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement);
  if (!view) throw new Error("no editor");
  act(() => view.dispatch({ selection: { anchor: 3 } }));
  const press = (mods: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, bubbles: true, cancelable: true, ...mods });
    act(() => {
      view.contentDOM.dispatchEvent(event);
    });
    return event;
  };
  expect(press({ ctrlKey: true }).defaultPrevented).toBe(false);
  expect(completionStatus(view.state)).toBeNull();
  expect(press({ altKey: true }).defaultPrevented).toBe(true);
  expect(completionStatus(view.state)).not.toBeNull();
});

test("ctrl_space_opens_completion: Ctrl+Space opens the list every time, also after Escape or a pick", async () => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  onTestFinished(() => spy.mockRestore());
  const completion = vi.fn(() => ({ from: 0, options: [{ label: "select" }, { label: "set" }] }));
  const { container } = render(
    <SqlEditor value="se" onChange={() => {}} dialect="postgres" onRun={() => {}} completionSource={completion} />,
  );
  const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement);
  if (!view) throw new Error("no editor");
  act(() => view.dispatch({ selection: { anchor: 2 } }));
  const ctrlSpace = () => {
    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      view.contentDOM.dispatchEvent(event);
    });
    return event;
  };
  for (let round = 0; round < 3; round++) {
    const event = ctrlSpace();
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    // Escape closes the list; the next Ctrl+Space opens it again.
    act(() => {
      fireEvent.keyDown(view.contentDOM, { key: "Escape", code: "Escape", keyCode: 27 });
    });
    expect(completionStatus(view.state)).toBeNull();
  }
  // A pick (Enter) inserts the option and closes the list; Ctrl+Space opens it again.
  ctrlSpace();
  await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  // CodeMirror ignores an Enter in the first moments of a list (its interaction delay).
  await new Promise((r) => setTimeout(r, 120));
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter", keyCode: 13 });
  });
  expect(view.state.doc.toString()).toBe("select");
  expect(completionStatus(view.state)).toBeNull();
  expect(ctrlSpace().defaultPrevented).toBe(true);
  await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  expect(completion.mock.calls.length).toBeGreaterThanOrEqual(5);
});

test("editor_colors_follow_theme: the SQL colours are the --sql-* tokens (dark / light), never literal colours", async () => {
  // The highlight style names tokens only, by role (§5.1: keywords, functions, numbers,
  // strings, comments); quoted identifiers stay plain text.
  const colorOf = (tag: unknown) =>
    sqlHighlightStyle.specs.find((s) => (Array.isArray(s.tag) ? s.tag : [s.tag]).includes(tag))?.color;
  expect(colorOf(t.keyword)).toBe("var(--sql-keyword)");
  expect(colorOf(t.standard(t.name))).toBe("var(--sql-function)");
  expect(colorOf(t.number)).toBe("var(--sql-number)");
  expect(colorOf(t.string)).toBe("var(--sql-string)");
  expect(colorOf(t.lineComment)).toBe("var(--sql-comment)");
  expect(colorOf(t.blockComment)).toBe("var(--sql-comment)");
  expect(colorOf(t.special(t.string))).toBe("var(--text)");
  expect(JSON.stringify(sqlHighlightStyle.specs.map(({ tag, ...style }) => style))).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  // Selection and the statement under the cursor (§5.1 "sélection", "requête courante").
  expect(JSON.stringify(editorThemeSpec)).toContain("var(--sql-selection)");
  expect(editorThemeSpec[".cm-currentStatement"].backgroundColor).toBe("var(--sql-current)");

  // The values and their contrast in both themes: tokens.test.ts (sql_editor_contrast).

  // In the editor: a keyword is drawn with the class whose rule is the keyword token.
  const { container } = render(<SqlEditor value="select 1 -- note" onChange={() => {}} dialect="postgres" onRun={() => {}} />);
  const rules = () =>
    Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
  await waitFor(() => {
    const keyword = [...container.querySelectorAll(".cm-line span")].find((s) => s.textContent === "select");
    expect(keyword).toBeDefined();
    const cls = [...(keyword as Element).classList];
    expect(cls.some((c) => new RegExp(`\\.${c}\\s*\\{[^}]*var\\(--sql-keyword\\)`).test(rules()))).toBe(true);
  });
});

test("the statement under the cursor is highlighted, not while a selection is made", () => {
  const { container } = render(
    <SqlEditor value={"select 1;\nselect\n  2;\nselect 3"} onChange={() => {}} dialect="postgres" onRun={() => {}} />,
  );
  const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement);
  if (!view) throw new Error("no editor");
  const current = () => [...container.querySelectorAll(".cm-line.cm-currentStatement")].map((l) => l.textContent);
  act(() => view.dispatch({ selection: { anchor: 13 } })); // in "select\n  2"
  expect(current()).toEqual(["select", "  2;"]);
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  expect(current()).toEqual(["select 3"]);
  act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));
  expect(current()).toEqual([]);
});

test("the band starts at the statement's first code line: a comment after the previous `;` is not banded", () => {
  const { container } = render(
    <SqlEditor value={"select 1; -- note\n/* more */\nselect 2"} onChange={() => {}} dialect="postgres" onRun={() => {}} />,
  );
  const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement);
  if (!view) throw new Error("no editor");
  const current = () => [...container.querySelectorAll(".cm-line.cm-currentStatement")].map((l) => l.textContent);
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  expect(current()).toEqual(["select 2"]);
  act(() => view.dispatch({ selection: { anchor: 3 } }));
  expect(current()).toEqual(["select 1; -- note"]);
});
