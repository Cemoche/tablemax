import { create } from "zustand";
import { SETTINGS_BOUNDS, cleanKeymap } from "../features/settings/bounds";
import { toAppError } from "../lib/errors";
import * as ipc from "../lib/ipc";
import { applyInterfaceScale, applyTheme } from "../lib/theme";
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
  interfaceScale: 1,
  dataFontSize: 13,
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** Message of the last failed load/update; cleared by the next successful one. */
  error: string | null;
  /** Last value stored by the backend; what a failed update reverts to. */
  confirmed: Settings;
  load: () => Promise<void>;
  /** Optimistic: applies `patch` at once, then the (clamped) value the backend stored. */
  update: (patch: Partial<Settings>) => Promise<void>;
  /** Font shortcuts: `delta` on the data and the editor font sizes, each within its bounds. */
  stepFontSizes: (delta: number) => Promise<void>;
}

/** The UI never trusts a keymap entry the backend or a caller did not validate. */
const cleaned = (s: Settings): Settings => ({ ...s, keymap: cleanKeymap(s.keymap) });

const clampTo = (key: "dataFontSize" | "editorFontSize", n: number) =>
  Math.min(SETTINGS_BOUNDS[key].max, Math.max(SETTINGS_BOUNDS[key].min, n));

// Updates reach the backend one at a time, in order. `latest` numbers the updates so a
// superseded one never overwrites the optimistic state of a newer one; `confirmed` is
// the last value the backend stored (a store field, so tests can reset it), which a failed latest update reverts to.
let latest = 0;
let queue: Promise<void> = Promise.resolve();

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  error: null,
  confirmed: DEFAULT_SETTINGS,
  load: async () => {
    try {
      const settings = cleaned(await ipc.settingsGet());
      applyTheme(settings.theme);
      applyInterfaceScale(settings.interfaceScale);
      set({ settings, confirmed: settings, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: toAppError(e).message });
    }
  },
  update: (patch) => {
    const seq = ++latest;
    const next = cleaned({ ...get().settings, ...patch });
    // Applies what `s` changes against the settings shown now (the zoom only when it moves).
    const show = (s: Settings) => {
      applyTheme(s.theme);
      if (s.interfaceScale !== get().settings.interfaceScale) applyInterfaceScale(s.interfaceScale);
    };
    show(next);
    set({ settings: next });
    const run = async () => {
      try {
        const stored = cleaned(await ipc.settingsSet(next));
        set({ confirmed: stored });
        if (seq === latest) {
          show(stored);
          set({ settings: stored, error: null });
        }
      } catch (e) {
        if (seq === latest) {
          const { confirmed } = get();
          show(confirmed);
          set({ settings: confirmed, error: toAppError(e).message });
        }
      }
    };
    const done = queue.then(run);
    queue = done;
    return done;
  },
  stepFontSizes: async (delta) => {
    const { dataFontSize, editorFontSize } = get().settings;
    const patch = {
      dataFontSize: clampTo("dataFontSize", dataFontSize + delta),
      editorFontSize: clampTo("editorFontSize", editorFontSize + delta),
    };
    if (patch.dataFontSize === dataFontSize && patch.editorFontSize === editorFontSize) return;
    await get().update(patch);
  },
}));
