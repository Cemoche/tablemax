import { create } from "zustand";
import { toAppError } from "../lib/errors";
import * as ipc from "../lib/ipc";
import { applyTheme } from "../lib/theme";
import type { Settings } from "../lib/types";

/** Mirrors `Settings::default()` in src-tauri/src/settings.rs. */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: "system",
  editorFontFamily: "",
  editorFontSize: 13,
  pageSize: 300,
  exactCountThreshold: 500_000,
  autoLimitDefault: false,
  autoLimitValue: 1000,
  keymap: {},
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** Message of the last failed load/update; cleared by the next successful one. */
  error: string | null;
  load: () => Promise<void>;
  /** Optimistic: applies `patch` at once, then the (clamped) value the backend stored. */
  update: (patch: Partial<Settings>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  error: null,
  load: async () => {
    try {
      const settings = await ipc.settingsGet();
      applyTheme(settings.theme);
      set({ settings, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: toAppError(e).message });
    }
  },
  update: async (patch) => {
    const previous = get().settings;
    const next = { ...previous, ...patch };
    applyTheme(next.theme);
    set({ settings: next });
    try {
      const stored = await ipc.settingsSet(next);
      applyTheme(stored.theme);
      set({ settings: stored, error: null });
    } catch (e) {
      applyTheme(previous.theme);
      set({ settings: previous, error: toAppError(e).message });
    }
  },
}));
