import { useAction } from "../../lib/keymap";
import { useSettings } from "../../stores/settings";

/**
 * Binds `font.increase` / `font.decrease` (Ctrl+= / Ctrl+- by default): one point more or
 * less on the data and the editor font sizes together, each within its bounds. Global, so
 * they also act in the SQL editor (CodeMirror binds neither combination).
 */
export function useFontShortcuts(): void {
  useAction("font.increase", () => void useSettings.getState().stepFontSizes(1));
  useAction("font.decrease", () => void useSettings.getState().stepFontSizes(-1));
}
