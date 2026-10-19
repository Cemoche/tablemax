// Connection URLs: export a saved connection (never its password) and parse a pasted one.
import { defaultSslMode } from "./ssl";
import { strings } from "./strings";
import type { ConnectionConfig, DriverKind, SshAuth, SshSettings, SslMode } from "./types";

const SCHEME: Record<DriverKind, string> = {
  postgres: "postgresql",
  mySql: "mysql",
  mariaDb: "mariadb",
  sqlite: "sqlite",
};

const KIND: Record<string, DriverKind> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mySql",
  mariadb: "mariaDb",
  sqlite: "sqlite",
};

const DEFAULT_PORT: Record<DriverKind, number> = { postgres: 5432, mySql: 3306, mariaDb: 3306, sqlite: 0 };

const LIBPQ: Record<SslMode, string> = {
  disable: "disable",
  prefer: "prefer",
  require: "require",
  verifyCa: "verify-ca",
  verifyFull: "verify-full",
};

const FROM_LIBPQ: Record<string, SslMode> = {
  disable: "disable",
  prefer: "prefer",
  require: "require",
  "verify-ca": "verifyCa",
  "verify-full": "verifyFull",
};

const FROM_MYSQL: Record<string, SslMode> = {
  DISABLED: "disable",
  PREFERRED: "prefer",
  REQUIRED: "require",
  VERIFY_CA: "verifyCa",
  VERIFY_IDENTITY: "verifyFull",
};

const bracket = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

function sshParam(ssh: SshSettings): string {
  return `${ssh.user ? `${ssh.user}@` : ""}${bracket(ssh.host)}${ssh.port !== null ? `:${ssh.port}` : ""}`;
}

/** The URL of a connection; it never contains a password. */
export function toConnectionUrl(cfg: ConnectionConfig): string {
  const scheme = SCHEME[cfg.kind];
  if (cfg.kind === "sqlite") {
    return `${scheme}://${(cfg.sqlitePath ?? "").split("/").map(encodeURIComponent).join("/")}`;
  }
  const user = cfg.user ? `${encodeURIComponent(cfg.user)}@` : "";
  const db = cfg.database ? `/${encodeURIComponent(cfg.database)}` : "";
  const params: string[] = [];
  // Omitted only for prefer on a local host or tunnel, where parsing restores it.
  if (!(cfg.ssl.mode === "prefer" && defaultSslMode(cfg.host, cfg.ssh !== null) === "prefer")) {
    params.push(`sslmode=${LIBPQ[cfg.ssl.mode]}`);
  }
  if (cfg.ssh) {
    params.push(`ssh=${encodeURIComponent(sshParam(cfg.ssh))}`);
    // Key file and secret storage are local choices and are not exported.
    if (cfg.ssh.auth !== "password") params.push(`ssh-auth=${cfg.ssh.auth}`);
  }
  const query = params.length ? `?${params.join("&")}` : "";
  return `${scheme}://${user}${bracket(cfg.host)}:${cfg.port}${db}${query}`;
}

/** The SSH settings of an `ssh=` value; a password after "user:" is never kept. */
function parseSsh(value: string, warnings: string[]): SshSettings | null {
  const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:@[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m) return null;
  const host = m[2].replace(/^\[|\]$/g, "");
  let user: string | null = m[1] ?? null;
  if (user?.includes(":")) {
    user = user.slice(0, user.indexOf(":")) || null;
    warnings.push(strings.url.sshPasswordIgnored);
  }
  return {
    host,
    port: m[3] ? Number(m[3]) : null,
    user,
    auth: "password",
    keyFile: null,
    secretMode: "keyring",
  };
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseConnectionUrl(input: string): {
  config: Partial<ConnectionConfig>;
  password: string | null;
  /** The URL carried a valid sslmode / ssl-mode (else the mode is just a default). */
  sslExplicit: boolean;
  warnings: string[];
} {
  const invalid = () => new Error(strings.url.invalid);
  const text = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1].toLowerCase();
  const kind = scheme ? KIND[scheme] : undefined;
  if (!kind) throw invalid();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  const noSsl = { caFile: null, certFile: null, keyFile: null };
  if (kind === "sqlite") {
    const path = decode(url.pathname);
    if (!path) throw invalid();
    const warnings = [...url.searchParams.keys()].map((k) => strings.url.unknownParam(k));
    return {
      config: { kind, sqlitePath: path, passwordMode: "none", ssl: { mode: "prefer", ...noSsl }, ssh: null },
      password: null,
      sslExplicit: false,
      warnings,
    };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw invalid();
  const port = url.port ? Number(url.port) : DEFAULT_PORT[kind];
  const isMysql = kind === "mySql" || kind === "mariaDb";
  const warnings: string[] = [];
  let mode: SslMode | null = null;
  let ssh: SshSettings | null = null;
  let sshAuth: SshAuth | null = null;
  for (const [key, value] of url.searchParams) {
    if (key === "sslmode" || key === "ssl-mode") {
      const found = key === "sslmode" ? FROM_LIBPQ[value.toLowerCase()] : FROM_MYSQL[value.toUpperCase()];
      if (found) mode = found;
      else warnings.push(strings.url.invalidSslMode(value));
    } else if (key === "ssh") {
      ssh = parseSsh(value, warnings);
      if (!ssh) throw invalid();
    } else if (key === "ssh-auth") {
      if (value === "password" || value === "key" || value === "agent") sshAuth = value;
      else warnings.push(strings.url.invalidSshAuth(value));
    } else warnings.push(strings.url.unknownParam(key));
  }
  if (ssh && sshAuth) {
    ssh = { ...ssh, auth: sshAuth, secretMode: sshAuth === "agent" ? "none" : "keyring" };
  }
  const sslExplicit = mode !== null;
  if (mode === "verifyCa" && isMysql) {
    mode = "verifyFull";
    warnings.push(strings.url.verifyCaMysql);
  }
  const password = url.password ? decode(url.password) : null;
  const database = decode(url.pathname.replace(/^\//, ""));
  return {
    config: {
      kind,
      host,
      port,
      ...(url.username ? { user: decode(url.username) } : {}),
      database: database || null,
      sqlitePath: null,
      ssl: { mode: mode ?? defaultSslMode(host, ssh !== null), ...noSsl },
      ssh,
    },
    password,
    sslExplicit,
    warnings,
  };
}
