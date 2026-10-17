import { strings } from "./strings";

/** The OS name the webview reports (`userAgentData.platform`, else `navigator.platform`). */
export function currentPlatform(): string {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return nav?.userAgentData?.platform || nav?.platform || "";
}

/** macOS, from the platform or the user agent (arguments for tests). */
export function isMac(
  platform: string = currentPlatform(),
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return /mac/i.test(platform) || /Macintosh|Mac OS X/.test(userAgent);
}

/** The "Mod" key of a shortcut is down: Cmd on macOS, Ctrl elsewhere (not both). */
export function isModKey(
  e: { ctrlKey: boolean; metaKey: boolean },
  mac: boolean = isMac(),
): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Label of a canonical shortcut spec ("Mod+Shift+Enter", "Alt+1", "Mod+,"):
 * "⌘+Shift+Enter" on macOS, "Ctrl+Shift+Enter" elsewhere, names from strings.ts.
 */
export function formatShortcut(spec: string, mac: boolean = isMac()): string {
  const { keyNames, keySeparator } = strings.settings;
  const parts = spec.split("+");
  const key = parts.pop() ?? "";
  const names = parts.map((m) => {
    switch (m) {
      case "Mod":
        return mac ? keyNames.cmd : keyNames.ctrl;
      case "Ctrl":
        return keyNames.ctrl;
      case "Alt":
        return mac ? keyNames.option : keyNames.alt;
      case "Shift":
        return keyNames.shift;
      case "Meta":
        return keyNames.cmd;
      default:
        return m;
    }
  });
  names.push(key.length === 1 ? key.toUpperCase() : key);
  return names.filter((n) => n !== "").join(keySeparator);
}
