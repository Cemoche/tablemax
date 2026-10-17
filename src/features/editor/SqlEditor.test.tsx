import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { useSettings, DEFAULT_SETTINGS } from "../../stores/settings";
import { applyTheme } from "../../lib/theme";
import { SqlEditor, buildEditorTheme, editorThemeSpec, insertAtCursor, replaceDocument } from "./SqlEditor";

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

test("insertAtCursor and replaceDocument are one undo step each", () => {
  const view = new EditorView({
    state: EditorState.create({ doc: "select 1;\n", selection: { anchor: 10 }, extensions: [history()] }),
  });
  insertAtCursor(view, "select 2");
  expect(view.state.doc.toString()).toBe("select 1;\nselect 2");
  expect(view.state.selection.main.head).toBe(18);
  replaceDocument(view, "select 3");
  expect(view.state.doc.toString()).toBe("select 3");
  undo(view);
  expect(view.state.doc.toString()).toBe("select 1;\nselect 2");
  undo(view);
  expect(view.state.doc.toString()).toBe("select 1;\n");
  // A selection is replaced by the inserted text.
  view.dispatch({ selection: { anchor: 0, head: 6 } });
  insertAtCursor(view, "SELECT");
  expect(view.state.doc.toString()).toBe("SELECT 1;\n");
  view.destroy();
});
