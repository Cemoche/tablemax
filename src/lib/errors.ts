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

/** Message = the server key's "SHA256:…" fingerprint. */
export function isHostKeyUnknown(e: AppError): boolean {
  return e.kind === "hostKeyUnknown";
}

/** Message = the received key's fingerprint; the connection is blocked. */
export function isHostKeyChanged(e: AppError): boolean {
  return e.kind === "hostKeyChanged";
}
