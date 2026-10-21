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
  mongoDb: 27017,
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

/**
 * A loaded config as the form edits it. SQLite has no password: never keyring/ask (the
 * backend forces "none" too). A stored verify-ca on MySQL/MariaDB (unsupported there)
 * shows as verify-full, the closest stricter mode, instead of a blank select.
 */
export const normalize = (c: ConnectionConfig): ConnectionConfig => {
  const out = withSslMode(c, true);
  const noPassword = out.kind === "sqlite" && out.passwordMode !== "none";
  return noPassword ? { ...out, passwordMode: "none" } : out;
};

/**
 * Open SQLite file… (#117): a new, unsaved SQLite connection on `path`, named after the
 * file without its extension. The form shows it; nothing is stored until Save or Connect.
 */
export function sqliteFileDraft(path: string): ConnectionConfig {
  const file = path.split(/[\\/]/).pop() ?? "";
  const dot = file.lastIndexOf(".");
  const blank = blankConnection();
  return normalize({
    ...blank,
    ...driverPatch(blank, "sqlite"),
    name: dot > 0 ? file.slice(0, dot) : file,
    sqlitePath: path,
  });
}

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
 * Whether the SSL mode of a config loaded into the form counts as picked by the user
 * (kept as is) rather than following host and SSH (`defaultSslMode`): a URL draft that
 * stated it, or a mode other than the default for the config's host and tunnel. A
 * stored mode equal to the default keeps following, so editing the host of a local
 * "prefer" connection to a remote one switches it to verify-full.
 */
export function sslModePicked(c: ConnectionConfig | null, sslExplicit: boolean): boolean {
  if (!c) return false;
  return sslExplicit || c.ssl.mode !== defaultSslMode(c.host, c.ssh !== null);
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
  if (c.kind === "sqlite") return c.ssh ? { ...c, ssh: null } : c;
  const ssh = c.ssh;
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

/**
 * The subtitle of a connection row: `tag : host:port : database` (no database part when
 * there is none), `tag : path` for SQLite.
 */
export function connectionSubtitle(c: ConnectionConfig): string {
  const tag = strings.env[c.envTag] ?? c.envTag;
  const sep = strings.connections.subtitleSeparator;
  const where =
    c.kind === "sqlite"
      ? [c.sqlitePath]
      : [`${c.host}:${c.port}`, c.database];
  return [tag, ...where.filter((p): p is string => !!p)].join(sep);
}

/**
 * The form's draft after Import from URL…: the URL's fields over `c`. The connection keeps
 * who it is (id, name, colour, tag, group, safe mode); a draft without a name takes the
 * database (the file name for SQLite, else the host).
 */
export function withUrlImport(c: ConnectionConfig, imported: Partial<ConnectionConfig>): ConnectionConfig {
  const next: ConnectionConfig = {
    ...c,
    ...imported,
    id: c.id,
    name: c.name,
    color: c.color,
    envTag: c.envTag,
    group: c.group,
    safeMode: c.safeMode,
  };
  if (next.name.trim()) return next;
  const name = next.kind === "sqlite" ? (next.sqlitePath?.split("/").pop() ?? "") : (next.database ?? next.host);
  return { ...next, name };
}

/** A canonical text of a draft: keys sorted, an absent field the same as null. */
function canonical(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Do two drafts hold the same settings (key order and null / absent fields aside)? */
export const sameDraft = (a: ConnectionConfig, b: ConnectionConfig): boolean => canonical(a) === canonical(b);

/**
 * `draft` moved onto `stored`, the connection as saved now (changed behind the form, the
 * toolbar's safe mode say): each field the user left as it was in `baseline` takes the
 * stored value, each field they edited keeps their value.
 */
export function rebaseDraft(
  draft: ConnectionConfig,
  baseline: ConnectionConfig,
  stored: ConnectionConfig,
): ConnectionConfig {
  const out: Record<string, unknown> = { ...stored };
  const keys = new Set([...Object.keys(draft), ...Object.keys(baseline), ...Object.keys(stored)]);
  const d = draft as unknown as Record<string, unknown>;
  const b = baseline as unknown as Record<string, unknown>;
  for (const k of keys) if (canonical(d[k]) !== canonical(b[k])) out[k] = d[k];
  return out as unknown as ConnectionConfig;
}
