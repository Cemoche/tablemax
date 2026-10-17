// Connection URLs: export a saved connection (never its password) and parse a pasted one.
import { defaultSslMode } from "./ssl";
import { strings } from "./strings";
import type { ConnectionConfig, DriverKind, SshSettings, SslMode } from "./types";

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
  if (cfg.kind === "sqlite") return `${scheme}://${cfg.sqlitePath ?? ""}`;
  const user = cfg.user ? `${encodeURIComponent(cfg.user)}@` : "";
  const db = cfg.database ? `/${encodeURIComponent(cfg.database)}` : "";
  const params: string[] = [];
  // Omitted only for prefer on a local host or tunnel, where parsing restores it.
  if (!(cfg.ssl.mode === "prefer" && defaultSslMode(cfg.host, cfg.ssh !== null) === "prefer")) {
    params.push(`sslmode=${LIBPQ[cfg.ssl.mode]}`);
  }
  if (cfg.ssh) params.push(`ssh=${encodeURIComponent(sshParam(cfg.ssh))}`);
  const query = params.length ? `?${params.join("&")}` : "";
  return `${scheme}://${user}${bracket(cfg.host)}:${cfg.port}${db}${query}`;
}

function parseSsh(value: string): SshSettings | null {
  const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:@[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m) return null;
  const host = m[2].replace(/^\[|\]$/g, "");
  return {
    host,
    port: m[3] ? Number(m[3]) : null,
    user: m[1] ?? null,
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
  for (const [key, value] of url.searchParams) {
    if (key === "sslmode" && FROM_LIBPQ[value.toLowerCase()]) mode = FROM_LIBPQ[value.toLowerCase()];
    else if (key === "ssl-mode" && FROM_MYSQL[value.toUpperCase()]) mode = FROM_MYSQL[value.toUpperCase()];
    else if (key === "ssh") {
      ssh = parseSsh(value);
      if (!ssh) throw invalid();
    } else warnings.push(strings.url.unknownParam(key));
  }
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
      user: decode(url.username),
      database: database || null,
      sqlitePath: null,
      ssl: { mode: mode ?? defaultSslMode(host, ssh !== null), ...noSsl },
      ssh,
    },
    password,
    warnings,
  };
}
