import { useCallback, useEffect, useRef, useState } from "react";
import {
  isHostKeyChanged,
  isHostKeyUnknown,
  isPasswordRequired,
  isSshAuthFailed,
  isSshPassphraseRequired,
  isSshPasswordRequired,
  toAppError,
} from "../../lib/errors";
import { strings } from "../../lib/strings";
import type { AppError, ConnectionConfig, SshAuth } from "../../lib/types";

export interface FlowSecrets {
  password: string | null;
  sshSecret: string | null;
  acceptFingerprint: string | null;
}

export type SecretPromptKind = "password" | "sshPassword" | "sshPassphrase";

export type FlowPrompt =
  | { kind: SecretPromptKind; error: string | null }
  | { kind: "hostKey"; fingerprint: string; host: string };

/** What a flow knows about the SSH side of the connection it runs for. */
export interface FlowTarget {
  /** The SSH server as configured: the host-key prompt's label when the error names none. */
  host: string;
  /** null without SSH. */
  sshAuth: SshAuth | null;
  /** With no SSH secret typed, the backend uses the one in the keyring. */
  sshSecretStored: boolean;
}

const NO_TARGET: FlowTarget = { host: "", sshAuth: null, sshSecretStored: false };

/** The flow target of `cfg`. */
export function flowTarget(cfg: ConnectionConfig): FlowTarget {
  const ssh = cfg.ssh;
  if (!ssh) return NO_TARGET;
  return {
    host: ssh.port !== null ? `${ssh.host}:${ssh.port}` : ssh.host,
    sshAuth: ssh.auth,
    sshSecretStored: cfg.id !== "" && ssh.auth !== "agent" && ssh.secretMode === "keyring",
  };
}

/** The prompt an error asks for, or null when the flow cannot continue. */
function promptFor(err: AppError, secrets: FlowSecrets, target: FlowTarget): FlowPrompt | null {
  // A secret that was given (typed, or stored for the SSH one) was rejected: say so.
  const secret = (kind: SecretPromptKind, rejected: boolean): FlowPrompt => ({
    kind,
    error: rejected ? strings.secretPrompt[kind].retry : null,
  });
  const sshGiven = secrets.sshSecret !== null || target.sshSecretStored;
  if (isPasswordRequired(err)) return secret("password", secrets.password !== null);
  if (isSshPasswordRequired(err)) return secret("sshPassword", secrets.sshSecret !== null);
  if (isSshPassphraseRequired(err)) return secret("sshPassphrase", sshGiven);
  // The server refused the SSH password (typed or stored): ask for it again.
  if (isSshAuthFailed(err) && target.sshAuth === "password") return secret("sshPassword", true);
  if (isHostKeyUnknown(err)) {
    return { kind: "hostKey", fingerprint: err.message, host: err.host ?? target.host };
  }
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
 * required, SSH password refused, unknown host key), shows the matching prompt, keeps
 * the secrets already given and runs again. `start` resolves with run's result, or undefined when the user
 * cancels a prompt; it rejects with any other error — a changed host key rejects with
 * `strings.ssh.hostKeyChanged`, never prompting.
 *
 * `context` (e.g. the connection) is bound to one `start`: every attempt of that flow
 * gets it, and `context` exposes it while the flow's prompt is open. `target`
 * (`flowTarget(cfg)`) tells which SSH secret a refusal concerns and labels the host-key
 * prompt when the backend does not name the server.
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
    async (initial: FlowSecrets, context: C, target: Partial<FlowTarget> = {}): Promise<T | undefined> => {
      const tgt: FlowTarget = { ...NO_TARGET, ...target };
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
              throw { kind: err.kind, message: strings.ssh.hostKeyChanged(err.message, err.host) };
            }
            const next = promptFor(err, secrets, tgt);
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
