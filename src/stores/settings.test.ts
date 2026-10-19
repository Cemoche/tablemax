import { beforeEach, expect, test, vi } from "vitest";
import * as ipc from "../lib/ipc";
import type { Settings } from "../lib/types";
import { DEFAULT_SETTINGS, useSettings } from "./settings";

vi.mock("../lib/ipc");

beforeEach(() => {
  vi.resetAllMocks();
  delete document.documentElement.dataset.theme;
  useSettings.setState({ settings: DEFAULT_SETTINGS, confirmed: DEFAULT_SETTINGS, loaded: false, error: null });
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
  await vi.waitFor(() =>
    expect(ipc.settingsSet).toHaveBeenCalledWith({
      ...DEFAULT_SETTINGS,
      editorFontSize: 99,
      theme: "light",
    }),
  );
  resolve({ ...DEFAULT_SETTINGS, editorFontSize: 24, theme: "light" });
  await p;
  expect(useSettings.getState().settings.editorFontSize).toBe(24);
  expect(useSettings.getState().error).toBeNull();
});

function deferred() {
  let resolve!: (s: Settings) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Settings>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a stale response does not clobber a newer optimistic update", async () => {
  const a = deferred();
  const b = deferred();
  vi.mocked(ipc.settingsSet).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const pa = useSettings.getState().update({ theme: "light" });
  const pb = useSettings.getState().update({ theme: "dark", editorFontSize: 99 });
  a.resolve({ ...DEFAULT_SETTINGS, theme: "light" });
  await pa;
  expect(useSettings.getState().settings.theme).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  await vi.waitFor(() => expect(ipc.settingsSet).toHaveBeenCalledTimes(2));
  b.resolve({ ...DEFAULT_SETTINGS, theme: "dark", editorFontSize: 24 });
  await pb;
  expect(useSettings.getState().settings.editorFontSize).toBe(24);
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("when the newer update fails it reverts to the last confirmed value", async () => {
  const a = deferred();
  const b = deferred();
  vi.mocked(ipc.settingsSet).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const pa = useSettings.getState().update({ theme: "light" });
  const pb = useSettings.getState().update({ theme: "dark" });
  a.resolve({ ...DEFAULT_SETTINGS, theme: "light" });
  await pa;
  await vi.waitFor(() => expect(ipc.settingsSet).toHaveBeenCalledTimes(2));
  b.reject({ kind: "io", message: "disk full" });
  await pb;
  expect(useSettings.getState().settings.theme).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(useSettings.getState().error).toBe("disk full");
});

test("update reverts and exposes the error when the backend rejects", async () => {
  vi.mocked(ipc.settingsSet).mockRejectedValue({ kind: "io", message: "disk full" });
  await useSettings.getState().update({ theme: "dark" });
  expect(useSettings.getState().settings.theme).toBe("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(useSettings.getState().error).toBe("disk full");
});

test("load drops keymap entries the backend should not have sent", async () => {
  vi.mocked(ipc.settingsGet).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    keymap: { "editor.run": "Mod+R", nope: "Mod+N", "grid.commit": "Mod-S" },
  });
  await useSettings.getState().load();
  expect(useSettings.getState().settings.keymap).toEqual({ "editor.run": "Mod+R" });
  expect(useSettings.getState().confirmed.keymap).toEqual({ "editor.run": "Mod+R" });
});

test("update sends and keeps a cleaned keymap", async () => {
  vi.mocked(ipc.settingsSet).mockImplementation(async (s) => ({ ...s, keymap: { ...s.keymap, bogus: "x" } }));
  await useSettings.getState().update({ keymap: { "query.new": "Mod+Shift+N", "query.newer": "Mod+N" } });
  expect(ipc.settingsSet).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, keymap: { "query.new": "Mod+Shift+N" } });
  expect(useSettings.getState().settings.keymap).toEqual({ "query.new": "Mod+Shift+N" });
});

test("interface_scale_applied_on_load_and_change", async () => {
  vi.mocked(ipc.windowSetZoom).mockResolvedValue(undefined);
  vi.mocked(ipc.settingsGet).mockResolvedValue({ ...DEFAULT_SETTINGS, interfaceScale: 1.15 });
  await useSettings.getState().load();
  expect(ipc.windowSetZoom).toHaveBeenLastCalledWith(1.15);

  // A change applies at once (optimistic), then the value the backend stored.
  vi.mocked(ipc.settingsSet).mockResolvedValue({ ...DEFAULT_SETTINGS, interfaceScale: 1.3 });
  const p = useSettings.getState().update({ interfaceScale: 1.5 });
  expect(ipc.windowSetZoom).toHaveBeenLastCalledWith(1.5);
  await p;
  expect(ipc.windowSetZoom).toHaveBeenLastCalledWith(1.3);

  // Another setting does not re-apply the zoom.
  vi.mocked(ipc.windowSetZoom).mockClear();
  vi.mocked(ipc.settingsSet).mockResolvedValue({ ...DEFAULT_SETTINGS, interfaceScale: 1.3, pageSize: 100 });
  await useSettings.getState().update({ pageSize: 100 });
  expect(ipc.windowSetZoom).not.toHaveBeenCalled();

  // A failed update reverts the zoom with the settings.
  vi.mocked(ipc.settingsSet).mockRejectedValue({ kind: "io", message: "boom" });
  await useSettings.getState().update({ interfaceScale: 0.9 });
  expect(ipc.windowSetZoom).toHaveBeenLastCalledWith(1.3);
});

test("a failing zoom call does not fail the settings load", async () => {
  vi.mocked(ipc.windowSetZoom).mockRejectedValue({ kind: "io", message: "no webview" });
  vi.mocked(ipc.settingsGet).mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark" });
  await useSettings.getState().load();
  expect(useSettings.getState().error).toBeNull();
  expect(useSettings.getState().settings.theme).toBe("dark");
});

test("the title bar choice is the one the window started with: a later update does not change it", async () => {
  useSettings.setState({ systemTitleBar: false });
  vi.mocked(ipc.settingsGet).mockResolvedValue({ ...DEFAULT_SETTINGS, useSystemTitleBar: true });
  await useSettings.getState().load();
  expect(useSettings.getState().systemTitleBar).toBe(true);
  vi.mocked(ipc.settingsSet).mockImplementation(async (s) => s);
  await useSettings.getState().update({ useSystemTitleBar: false });
  expect(useSettings.getState().settings.useSystemTitleBar).toBe(false);
  expect(useSettings.getState().systemTitleBar).toBe(true);
});
