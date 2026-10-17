import type { AppError } from "./types";
import { strings } from "./strings";

/** Normalises whatever a rejected invoke() carried into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    return e as AppError;
  }
  const message = typeof e === "string" ? e : e instanceof Error ? e.message : strings.unknownError;
  return { kind: "io", message };
}

export function isPasswordRequired(e: AppError): boolean {
  return e.kind === "auth" && e.message === "password required";
}

export function isSshPasswordRequired(e: AppError): boolean {
  return e.kind === "auth" && e.message === "ssh password required";
}

export function isSshPassphraseRequired(e: AppError): boolean {
  return e.kind === "auth" && e.message === "ssh passphrase required";
}

/** The SSH server refused the credentials (password, key or agent identities). */
export function isSshAuthFailed(e: AppError): boolean {
  return e.kind === "auth" && e.message === "ssh authentication failed";
}

/** Message = the server key's "SHA256:…" fingerprint; `host` = the server checked. */
export function isHostKeyUnknown(e: AppError): boolean {
  return e.kind === "hostKeyUnknown";
}

/** Message = the received key's fingerprint, `host` = the server; the connection is blocked. */
export function isHostKeyChanged(e: AppError): boolean {
  return e.kind === "hostKeyChanged";
}

/** A TablePlus export read with the wrong password (or a damaged file). */
export function isWrongExportPassword(e: AppError): boolean {
  return e.kind === "invalid" && e.message === "wrong password or corrupted file";
}

/** A previewed import that timed out or was already used. */
export function isImportExpired(e: AppError): boolean {
  return e.kind === "notFound" && e.message === "import expired";
}

/**
 * A protected connection refused an unconfirmed batch: nothing ran. Message = the
 * comma-separated indices of the statements that need confirmation ("1" or "0,1,2").
 */
export function isConfirmationRequired(e: AppError): boolean {
  return e.kind === "confirmationRequired";
}

/**
 * The statement indices a `confirmationRequired` message names. Tolerant: an
 * unparsable message (or an out-of-range index) means every statement needs it.
 */
export function parseConfirmationIndices(message: string, count: number): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  const parts = message.split(",").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return all;
  const idx = [...new Set(parts.map(Number))].filter((i) => i < count).sort((a, b) => a - b);
  return idx.length > 0 ? idx : all;
}
