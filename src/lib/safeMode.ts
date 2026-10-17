import { strings } from "./strings";
import type { ConnectionConfig, EnvTag, SafeMode } from "./types";

/** What a connection without an explicit safe mode gets for its environment tag. */
export const defaultSafeMode = (tag: EnvTag): SafeMode => (tag === "prod" ? "confirmWrites" : "off");

/** Mirrors the backend rule (safety.rs): explicit mode, else prod = confirmWrites, else off. */
export const effectiveSafeMode = (cfg: Pick<ConnectionConfig, "envTag" | "safeMode">): SafeMode =>
  cfg.safeMode ?? defaultSafeMode(cfg.envTag);

export const safeModeLabel = (mode: SafeMode): string =>
  ({
    off: strings.safety.modeOff,
    confirmWrites: strings.safety.modeConfirmWrites,
    confirmAll: strings.safety.modeConfirmAll,
  })[mode];
