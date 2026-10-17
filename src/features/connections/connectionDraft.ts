// Pure rules of the connection form: defaults, driver switches, SSL mode defaults and
// what is sent to the backend.
import {
  isPasswordRequired,
  isSshPassphraseRequired,
  isSshPasswordRequired,
} from "../../lib/errors";
import { defaultSslMode, sslModesFor } from "../../lib/ssl";
import { strings } from "../../lib/strings";
import {
  SWATCHES,
  type AppError,
  type ConnectionConfig,
  type DriverKind,
  type SshSettings,
} from "../../lib/types";

const DEFAULT_PORT: Record<DriverKind, number> = {
  postgres: 5432,
  mySql: 3306,
  mariaDb: 3306,
  sqlite: 0,
};

export const blankConnection = (): ConnectionConfig => ({
  id: "",
  name: "",
  color: SWATCHES[0],
  envTag: "local",
  kind: "postgres",
  host: "localhost",
  port: 5432,
  user: "",
  database: null,
  sqlitePath: null,
  passwordMode: "keyring",
  group: null,
  ssl: { mode: defaultSslMode("localhost", false), caFile: null, certFile: null, keyFile: null },
  ssh: null,
});

/** SQLite has no password: never keyring/ask (the backend forces "none" too). */
export const normalize = (c: ConnectionConfig): ConnectionConfig =>
  c.kind === "sqlite" && c.passwordMode !== "none" ? { ...c, passwordMode: "none" } : c;

/** The changes of switching `c` to the `kind` driver. */
export const driverPatch = (c: ConnectionConfig, kind: DriverKind): Partial<ConnectionConfig> => ({
  kind,
  port: DEFAULT_PORT[kind] || c.port,
  // "none" only exists for SQLite in this form: leaving SQLite restores the default.
  passwordMode:
    kind === "sqlite"
      ? "none"
      : c.kind === "sqlite" && c.passwordMode === "none"
        ? "keyring"
        : c.passwordMode,
});

/**
 * `c` with an SSL mode its driver supports: the default for its host and SSH tunnel
 * while the user has not picked a mode, and verify-full instead of verify-ca on
 * MySQL/MariaDB (the closest stricter mode).
 */
export function withSslMode(c: ConnectionConfig, picked: boolean): ConnectionConfig {
  const mode = picked ? c.ssl.mode : defaultSslMode(c.host, c.ssh !== null);
  const allowed = sslModesFor(c.kind).includes(mode) ? mode : "verifyFull";
  return allowed === c.ssl.mode ? c : { ...c, ssl: { ...c.ssl, mode: allowed } };
}

/**
 * The config sent to the backend. The agent has no secret; key auth with no
 * passphrase typed nor stored (`stored` = the saved SSH settings) is an unencrypted
 * key ("none"), so Save does not ask for a passphrase the key does not have.
 */
export function forBackend(
  c: ConnectionConfig,
  stored: SshSettings | null,
  typedSshSecret: string | null,
): ConnectionConfig {
  const ssh = c.kind === "sqlite" ? null : c.ssh;
  if (!ssh) return c;
  const passphraseStored = stored?.auth === "key" && stored.secretMode === "keyring";
  const noSecret =
    ssh.auth === "agent" ||
    (ssh.auth === "key" && ssh.secretMode === "keyring" && typedSshSecret === null && !passphraseStored);
  return noSecret ? { ...c, ssh: { ...ssh, secretMode: "none" } } : c;
}

/** Inline text of a form error; a re-asked secret on Save means the identity was edited. */
export function errorText(err: AppError): string {
  if (isPasswordRequired(err)) return strings.form.passwordRequired;
  if (isSshPasswordRequired(err)) return strings.form.sshPasswordRequired;
  if (isSshPassphraseRequired(err)) return strings.form.sshPassphraseRequired;
  return err.message;
}
