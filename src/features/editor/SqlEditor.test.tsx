import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { useSettings, DEFAULT_SETTINGS } from "../../stores/settings";
import { applyTheme } from "../../lib/theme";
import { SqlEditor } from "./SqlEditor";
import { buildEditorTheme, editorThemeSpec } from "./SqlEditor";

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

test("editor font size and family come from the settings", async () => {
  mount();
  await act(async () =>
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, editorFontSize: 20, editorFontFamily: "Fira Code" },
    }),
  );
  const rules = Array.from(document.querySelectorAll("style"))
    .map((s) => s.textContent)
    .join("\n");
  expect(rules).toContain("font-size: 20px");
  expect(rules).toContain("Fira Code");
});
