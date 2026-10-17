import { strings } from "../../lib/strings";

/** `mod` = Ctrl on Linux/Windows, ⌘ on macOS; `ctrl` = the Ctrl key on every platform. */
export type ShortcutKey = keyof typeof strings.settings.keyNames;

/** Read-only list of the shortcuts that exist today (customization comes later). */
export const SHORTCUTS: { keys: ShortcutKey[]; label: string }[] = [
  { keys: ["mod", "enter"], label: strings.settings.shortcutRun },
  { keys: ["mod", "shift", "enter"], label: strings.settings.shortcutRunAll },
  { keys: ["ctrl", "t"], label: strings.settings.shortcutNewTab },
  { keys: ["ctrl", "w"], label: strings.settings.shortcutCloseTab },
  { keys: ["mod", "comma"], label: strings.settings.shortcutSettings },
];

export const isMacPlatform = (platform: string): boolean => /mac/i.test(platform);

/** The OS name the webview reports (`userAgentData.platform`, else `navigator.platform`). */
export function currentPlatform(): string {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return nav?.userAgentData?.platform || nav?.platform || "";
}

/** `Ctrl+Shift+Enter` / `⌘+Shift+Enter`, with key names from strings.ts. */
export function formatShortcut(keys: ShortcutKey[], platform: string = currentPlatform()): string {
  const { keyNames, keySeparator } = strings.settings;
  return keys
    .map((k) => (k === "mod" ? (isMacPlatform(platform) ? keyNames.cmd : keyNames.ctrl) : keyNames[k]))
    .join(keySeparator);
}
