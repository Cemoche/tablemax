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
