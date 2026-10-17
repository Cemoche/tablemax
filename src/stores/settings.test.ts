import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { Settings } from "../lib/types";
import { DEFAULT_SETTINGS, useSettings } from "./settings";

vi.mock("../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  delete document.documentElement.dataset.theme;
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: false, error: null });
});

test("load fetches the settings and applies the theme", async () => {
  vi.mocked(ipc.settingsGet).mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark" });
  await useSettings.getState().load();
  expect(useSettings.getState().loaded).toBe(true);
  expect(useSettings.getState().settings.theme).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("a failed load keeps the defaults, marks the store loaded and exposes the error", async () => {
  vi.mocked(ipc.settingsGet).mockRejectedValue({ kind: "io", message: "boom" });
  await useSettings.getState().load();
  expect(useSettings.getState().loaded).toBe(true);
  expect(useSettings.getState().settings).toEqual(DEFAULT_SETTINGS);
  expect(useSettings.getState().error).toBe("boom");
});

test("update applies optimistically, then the clamped value from the backend", async () => {
  let resolve!: (s: Settings) => void;
  vi.mocked(ipc.settingsSet).mockReturnValue(new Promise((r) => (resolve = r)));
  const p = useSettings.getState().update({ editorFontSize: 99, theme: "light" });
  expect(useSettings.getState().settings.editorFontSize).toBe(99);
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(ipc.settingsSet).toHaveBeenCalledWith({
    ...DEFAULT_SETTINGS,
    editorFontSize: 99,
    theme: "light",
  });
  resolve({ ...DEFAULT_SETTINGS, editorFontSize: 24, theme: "light" });
  await p;
  expect(useSettings.getState().settings.editorFontSize).toBe(24);
  expect(useSettings.getState().error).toBeNull();
});

test("update reverts and exposes the error when the backend rejects", async () => {
  vi.mocked(ipc.settingsSet).mockRejectedValue({ kind: "io", message: "disk full" });
  await useSettings.getState().update({ theme: "dark" });
  expect(useSettings.getState().settings.theme).toBe("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(useSettings.getState().error).toBe("disk full");
});
