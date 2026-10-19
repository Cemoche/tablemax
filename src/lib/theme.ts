import { useEffect, useState } from "react";
import * as ipc from "./ipc";
import type { ThemeSetting } from "./types";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** `system` removes the attribute so the OS color scheme decides (see tokens.css). */
export function applyTheme(theme: ThemeSetting) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/**
 * Applies the interface size: native zoom of the webview, so the canvas grid, menus and
 * popovers follow. A failure (no window, e.g. in a test or the browser preview) leaves the
 * zoom as it is; it never fails the settings.
 */
export function applyInterfaceScale(scale: number): void {
  // Called synchronously (the zoom moves with the optimistic settings); `?.` because a
  // mocked ipc in tests returns undefined.
  ipc.windowSetZoom(scale)?.catch(() => {});
}

function resolveDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** True when the effective theme is dark: follows `data-theme` and the OS color scheme. */
export function useResolvedDark(): boolean {
  const [dark, setDark] = useState(resolveDark);
  useEffect(() => {
    const update = () => setDark(resolveDark());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
    mq?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      mq?.removeEventListener("change", update);
    };
  }, []);
  return dark;
}
