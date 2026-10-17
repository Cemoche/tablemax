import { strings } from "../../lib/strings";

/** Read-only list of the shortcuts that exist today, as canonical specs (see `formatShortcut`). */
export const SHORTCUTS: { spec: string; label: string }[] = [
  { spec: "Mod+Enter", label: strings.settings.shortcutRun },
  { spec: "Mod+Shift+Enter", label: strings.settings.shortcutRunAll },
  { spec: "Ctrl+T", label: strings.settings.shortcutNewTab },
  { spec: "Ctrl+W", label: strings.settings.shortcutCloseTab },
  { spec: "Mod+,", label: strings.settings.shortcutSettings },
  { spec: "Mod+S", label: strings.settings.shortcutCommit },
  { spec: "Mod+I", label: strings.settings.shortcutRowDetails },
  { spec: "Alt+1", label: strings.settings.shortcutDataView },
  { spec: "Alt+2", label: strings.settings.shortcutStructureView },
];
