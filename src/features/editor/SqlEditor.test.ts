import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, test } from "vitest";
import { buildEditorTheme, editorThemeSpec, insertAtCursor, replaceDocument } from "./SqlEditor";

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
