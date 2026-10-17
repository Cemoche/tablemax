import { strings } from "../../lib/strings";

/** Read-only list of the shortcuts that exist today (customization comes later). */
export const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "Mod+Enter", label: strings.settings.shortcutRun },
  { keys: "Mod+Shift+Enter", label: strings.settings.shortcutRunAll },
  { keys: "Ctrl+T", label: strings.settings.shortcutNewTab },
  { keys: "Ctrl+W", label: strings.settings.shortcutCloseTab },
  { keys: "Mod+,", label: strings.settings.shortcutSettings },
];
