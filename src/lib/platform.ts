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

/** Linux (the desktop, not Android), from the platform or the user agent (arguments for tests). */
export function isLinux(
  platform: string = currentPlatform(),
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  if (/android/i.test(platform) || /Android/.test(userAgent)) return false;
  return /linux/i.test(platform) || (!platform && /Linux/.test(userAgent));
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
 * "⌘+Shift+Enter" on macOS, "Ctrl+Shift+Enter" elsewhere, names from strings.ts. A literal
 * Meta is ⌘ on macOS and the Super key elsewhere (Linux first; Windows calls it Win).
 */
export function formatShortcut(spec: string, mac: boolean = isMac()): string {
  const { keyNames, keyLabels, keySeparator } = strings.settings;
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
        return mac ? keyNames.cmd : keyNames.meta;
      default:
        return m;
    }
  });
  const label = Object.prototype.hasOwnProperty.call(keyLabels, key) ? keyLabels[key] : key;
  names.push(key.length === 1 ? key.toUpperCase() : label);
  return names.filter((n) => n !== "").join(keySeparator);
}

/**
 * A canonical shortcut spec as an `aria-keyshortcuts` value (WAI-ARIA names: Control, Meta,
 * Alt, Shift, then the key's `KeyboardEvent.key` name): "Mod+Shift+C" is "Control+Shift+C"
 * off macOS and "Meta+Shift+C" on macOS. Not shown to the user, so not in strings.ts.
 */
export function ariaShortcut(spec: string, mac: boolean = isMac()): string {
  const parts = spec.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => (m === "Mod" ? (mac ? "Meta" : "Control") : m === "Ctrl" ? "Control" : m));
  return [...mods, key].join("+");
}
