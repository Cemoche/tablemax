/** macOS, from the WebView's platform / user agent (arguments for tests). */
export function isMacPlatform(
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return /mac/i.test(platform) || /Macintosh|Mac OS X/.test(userAgent);
}

/** The "Mod" key of a shortcut is down: Cmd on macOS, Ctrl elsewhere (not both). */
export function isModKey(
  e: { ctrlKey: boolean; metaKey: boolean },
  mac: boolean = isMacPlatform(),
): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** How a Mod+<key> shortcut reads in labels: "⌘S" on macOS, "Ctrl+S" elsewhere. */
export function modShortcut(key: string, mac: boolean = isMacPlatform()): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** How an Alt+<key> shortcut reads in labels: "⌥1" on macOS, "Alt+1" elsewhere. */
export function altShortcut(key: string, mac: boolean = isMacPlatform()): string {
  return mac ? `⌥${key}` : `Alt+${key}`;
}
