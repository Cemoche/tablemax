import { useCallback, useEffect, useRef, useState } from "react";
import {
  isHostKeyChanged,
  isHostKeyUnknown,
  isPasswordRequired,
  isSshPassphraseRequired,
  isSshPasswordRequired,
  toAppError,
} from "../../lib/errors";
import { strings } from "../../lib/strings";
import type { AppError, ConnectionConfig } from "../../lib/types";

export interface FlowSecrets {
  password: string | null;
  sshSecret: string | null;
  acceptFingerprint: string | null;
}

export type SecretPromptKind = "password" | "sshPassword" | "sshPassphrase";

export type FlowPrompt =
  | { kind: SecretPromptKind; error: string | null }
  | { kind: "hostKey"; fingerprint: string; host: string };

/** The SSH server of `cfg` as the host-key prompt names it ("" without SSH). */
export function hostKeyLabel(cfg: ConnectionConfig): string {
  if (!cfg.ssh) return "";
  return cfg.ssh.port !== null ? `${cfg.ssh.host}:${cfg.ssh.port}` : cfg.ssh.host;
}

/** The prompt an error asks for, or null when the flow cannot continue. */
function promptFor(err: AppError, secrets: FlowSecrets, host: string): FlowPrompt | null {
  // A required secret that was already given was rejected: say so in the prompt.
  const secret = (kind: SecretPromptKind, given: string | null): FlowPrompt => ({
    kind,
    error: given !== null ? strings.secretPrompt[kind].retry : null,
  });
  if (isPasswordRequired(err)) return secret("password", secrets.password);
  if (isSshPasswordRequired(err)) return secret("sshPassword", secrets.sshSecret);
  if (isSshPassphraseRequired(err)) return secret("sshPassphrase", secrets.sshSecret);
  if (isHostKeyUnknown(err)) return { kind: "hostKey", fingerprint: err.message, host };
  return null;
}

/** `secrets` with the prompt's answer applied. */
function answered(secrets: FlowSecrets, prompt: FlowPrompt, value: string): FlowSecrets {
  switch (prompt.kind) {
    case "password":
      return { ...secrets, password: value };
    case "sshPassword":
    case "sshPassphrase":
      return { ...secrets, sshSecret: value };
    case "hostKey":
      return { ...secrets, acceptFingerprint: prompt.fingerprint };
  }
}

/**
 * Runs `run` and, on each recognised error (password / SSH password / passphrase
 * required, unknown host key), shows the matching prompt, keeps the secrets already
 * given and runs again. `start` resolves with run's result, or undefined when the user
 * cancels a prompt; it rejects with any other error — a changed host key rejects with
 * `strings.ssh.hostKeyChanged`, never prompting.
 *
 * `context` (e.g. the connection) is bound to one `start`: every attempt of that flow
 * gets it, and `context` exposes it while the flow's prompt is open. `host` labels the
 * host-key prompt (the SSH server).
 *
 * Single flight: a new `start` supersedes the running flow, which then resolves
 * undefined without prompting, retrying or reporting its result or error, and never
 * touches the new flow's prompt.
 */
export function useConnectFlow<C, T>(run: (secrets: FlowSecrets, context: C) => Promise<T>) {
  const [active, setActive] = useState<{ prompt: FlowPrompt; context: C } | null>(null);
  const runRef = useRef(run);
  runRef.current = run;
  /** Resolves the prompt on screen with its answer, or null for Cancel. */
  const answerRef = useRef<((value: string | null) => void) | null>(null);
  /** Generation of the current flow; older flows are superseded. */
  const genRef = useRef(0);

  /** Closes the prompt and hands its answer (null = Cancel) to the waiting flow. */
  const settle = useCallback((value: string | null) => {
    const answer = answerRef.current;
    answerRef.current = null;
    setActive(null);
    answer?.(value);
  }, []);

  const start = useCallback(
    async (initial: FlowSecrets, context: C, host = ""): Promise<T | undefined> => {
      const gen = ++genRef.current;
      const current = () => genRef.current === gen;
      settle(null); // supersede the previous flow's prompt, if any
      const ask = (prompt: FlowPrompt) =>
        new Promise<string | null>((resolve) => {
          answerRef.current = resolve;
          setActive({ prompt, context });
        });
      let secrets = initial;
      try {
        for (;;) {
          let result: T;
          try {
            result = await runRef.current(secrets, context);
          } catch (e) {
            if (!current()) return undefined;
            const err = toAppError(e);
            if (isHostKeyChanged(err)) {
              throw { kind: err.kind, message: strings.ssh.hostKeyChanged(err.message) };
            }
            const next = promptFor(err, secrets, host);
            if (!next) throw e;
            const value = await ask(next);
            if (value === null || !current()) return undefined;
            secrets = answered(secrets, next, value);
            continue;
          }
          return current() ? result : undefined;
        }
      } finally {
        if (current()) {
          answerRef.current = null;
          setActive(null);
        }
      }
    },
    [settle],
  );

  const submit = useCallback((secret: string) => settle(secret), [settle]);
  const trust = useCallback(() => settle(""), [settle]);
  const cancel = useCallback(() => settle(null), [settle]);

  // A prompt left open by an unmount ends its flow as cancelled.
  useEffect(() => () => answerRef.current?.(null), []);

  /** `submit` answers a secret prompt, `trust` accepts the host-key prompt's fingerprint. */
  return {
    start,
    prompt: active?.prompt ?? null,
    /** The context of the flow whose prompt is open. */
    context: active?.context ?? null,
    submit,
    trust,
    cancel,
  };
}
