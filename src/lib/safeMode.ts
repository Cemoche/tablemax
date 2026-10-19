import { strings } from "./strings";
import type { ConnectionConfig, EnvTag, SafeMode } from "./types";

/** What a connection without an explicit safe mode gets for its environment tag. */
export const defaultSafeMode = (tag: EnvTag): SafeMode => (tag === "prod" ? "confirmWrites" : "off");

/** Mirrors the backend rule (safety.rs): explicit mode, else prod = confirmWrites, else off. */
export const effectiveSafeMode = (cfg: Pick<ConnectionConfig, "envTag" | "safeMode">): SafeMode =>
  cfg.safeMode ?? defaultSafeMode(cfg.envTag);

const RANK: Record<SafeMode, number> = { off: 0, confirmWrites: 1, confirmAll: 2 };

/** Mirrors `safety::stricter`. */
export const stricterSafeMode = (a: SafeMode, b: SafeMode): SafeMode => (RANK[a] >= RANK[b] ? a : b);

type ModeSource = Pick<ConnectionConfig, "envTag" | "safeMode">;

/**
 * The mode the backend enforces on an open workspace (Ruling R16, `workspace_safe_mode` in
 * manager.rs): the stricter of the saved connection's and the config the workspace was
 * opened with, so tightening applies at once and loosening at the next open; a deleted
 * connection (`saved` undefined) keeps the opened config's mode.
 */
export const enforcedSafeMode = (saved: ModeSource | undefined, opened: ModeSource): SafeMode =>
  saved ? stricterSafeMode(effectiveSafeMode(saved), effectiveSafeMode(opened)) : effectiveSafeMode(opened);

/** Lower-case mode wording used after "Safe mode:" (banner, confirmation dialog). */
export const safeModeBannerText = (mode: SafeMode): string =>
  ({
    off: strings.safety.bannerModeOff,
    confirmWrites: strings.safety.bannerModeConfirmWrites,
    confirmAll: strings.safety.bannerModeConfirmAll,
  })[mode];

export const safeModeLabel = (mode: SafeMode): string =>
  ({
    off: strings.safety.modeOff,
    confirmWrites: strings.safety.modeConfirmWrites,
    confirmAll: strings.safety.modeConfirmAll,
  })[mode];
