import { act, fireEvent, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import type { Settings } from "../../lib/types";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { useFontShortcuts } from "./useFontShortcuts";

vi.mock("../../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.settingsSet).mockImplementation(async (s: Settings) => s);
  useSettings.setState({ settings: DEFAULT_SETTINGS, confirmed: DEFAULT_SETTINGS, loaded: true, error: null });
});

const press = (code: "Equal" | "Minus") => fireEvent.keyDown(window, { code, ctrlKey: true });
const sizes = () => {
  const { dataFontSize, editorFontSize } = useSettings.getState().settings;
  return [dataFontSize, editorFontSize];
};

test("font_shortcuts_change_both_sizes_within_bounds", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, dataFontSize: 13, editorFontSize: 16 } });
  renderHook(() => useFontShortcuts());

  press("Equal");
  expect(sizes()).toEqual([14, 17]);
  press("Minus");
  press("Minus");
  expect(sizes()).toEqual([12, 15]);

  // Each size stops at its own bound; the other one keeps moving.
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, dataFontSize: 24, editorFontSize: 22 } });
  press("Equal");
  expect(sizes()).toEqual([24, 23]);
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, dataFontSize: 10, editorFontSize: 10 } });
  vi.mocked(ipc.settingsSet).mockClear();
  press("Minus");
  expect(sizes()).toEqual([10, 10]);
  // Nothing to change: nothing is saved.
  expect(ipc.settingsSet).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(useSettings.getState().error).toBeNull());
});

test("the font shortcuts are reassignable keymap actions", () => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, dataFontSize: 13, editorFontSize: 13, keymap: { "font.increase": "Alt+=" } },
  });
  renderHook(() => useFontShortcuts());
  press("Equal");
  expect(sizes()).toEqual([13, 13]);
  fireEvent.keyDown(window, { code: "Equal", altKey: true });
  expect(sizes()).toEqual([14, 14]);
});

test("font_size_alternates: Ctrl++ (Shift+=) and the numpad's + / − change the sizes too (#90)", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, dataFontSize: 13, editorFontSize: 13 } });
  renderHook(() => useFontShortcuts());
  fireEvent.keyDown(window, { code: "Equal", key: "+", ctrlKey: true, shiftKey: true });
  expect(sizes()).toEqual([14, 14]);
  fireEvent.keyDown(window, { code: "NumpadAdd", key: "+", ctrlKey: true });
  expect(sizes()).toEqual([15, 15]);
  fireEvent.keyDown(window, { code: "NumpadSubtract", key: "-", ctrlKey: true });
  fireEvent.keyDown(window, { code: "NumpadSubtract", key: "-", ctrlKey: true });
  expect(sizes()).toEqual([13, 13]);
  // A custom combination replaces the alternates as well.
  act(() =>
    useSettings.setState({
      settings: { ...useSettings.getState().settings, keymap: { "font.increase": "Alt+=" } },
    }),
  );
  fireEvent.keyDown(window, { code: "NumpadAdd", key: "+", ctrlKey: true });
  expect(sizes()).toEqual([13, 13]);
  vi.restoreAllMocks();
});
