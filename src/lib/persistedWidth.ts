/**
 * A panel width kept per machine in localStorage (the sidebar, the row details): clamped
 * to [min, max] and rounded; an unreadable or missing value gives `def`. Storage failures
 * (private mode, quota) only lose the width for the next start.
 */
export function persistedWidth(key: string, def: number, min: number, max: number) {
  const clamp = (px: number) => Math.round(Math.min(max, Math.max(min, px)));
  return {
    clamp,
    /** The width saved by the last session, or the default. */
    load: (): number => {
      try {
        const n = Number.parseInt(localStorage.getItem(key) ?? "", 10);
        return Number.isFinite(n) ? clamp(n) : def;
      } catch {
        return def;
      }
    },
    save: (px: number): void => {
      try {
        localStorage.setItem(key, String(px));
      } catch {
        // Storage unavailable: the width only lasts for this session.
      }
    },
  };
}
