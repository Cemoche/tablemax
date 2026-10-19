// MongoDB connection strings: parse a pasted one and write a saved connection's (never its
// password). The rules (TLS mapping, authSource, allowed and refused options) are the
// "Global Constraints" of docs/superpowers/plans/2026-10-19-tablemax-mongodb-01-read.md.
import { strings } from "./strings";
import type { ConnectionConfig, MongoAuth, MongoSettings, SslMode } from "./types";

/** Advanced options that are kept (and the only ones saved) in `MongoSettings.options`. */
export const MONGO_ALLOWED_OPTIONS = [
  "readPreference",
  "readPreferenceTags",
  "maxStalenessSeconds",
  "appName",
  "connectTimeoutMS",
  "serverSelectionTimeoutMS",
  "socketTimeoutMS",
  "heartbeatFrequencyMS",
  "localThresholdMS",
  "maxPoolSize",
  "minPoolSize",
  "maxIdleTimeMS",
  "retryReads",
  "directConnection",
] as const;

/**
 * Options that make an import impossible. `authMechanism` is refused only for a value
 * other than SCRAM / PLAIN, and every `autoEncryption*` option is refused.
 */
export const MONGO_REFUSED_OPTIONS = [
  "authMechanismProperties",
  "tlsCertificateKeyFile",
  "tlsCertificateKeyFilePassword",
  "tlsAllowInvalidHostnames",
  "proxyHost",
  "proxyPort",
  "proxyUsername",
  "proxyPassword",
] as const;

const DEFAULT_PORT = 27017;
const CANONICAL = new Map<string, string>(
  [...MONGO_ALLOWED_OPTIONS, ...MONGO_REFUSED_OPTIONS].map((k) => [k.toLowerCase(), k]),
);
const MECHANISM: Record<string, MongoAuth> = {
  "SCRAM-SHA-1": "scramSha1",
  "SCRAM-SHA-256": "scramSha256",
  PLAIN: "plain",
};
const MECHANISM_NAME: Record<MongoAuth, string | null> = {
  default: null,
  scramSha1: "SCRAM-SHA-1",
  scramSha256: "SCRAM-SHA-256",
  plain: "PLAIN",
};

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const bracket = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** `host`, `host:port`, `[v6]` or `[v6]:port` as [host, port | null]; null when malformed. */
function splitHost(entry: string): [string, number | null] | null {
  const m = /^(\[[^\]]+\]|[^:[\]/@]+)(?::(\d{1,5}))?$/.exec(entry);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return [m[1].replace(/^\[|\]$/g, ""), port];
}

const isTrue = (v: string) => v.toLowerCase() === "true";

export function parseMongoUri(uri: string): {
  patch: Partial<ConnectionConfig>;
  password: string | null;
  /** Options that are not kept. */
  ignored: string[];
  /** Options that make the import impossible. */
  refused: string[];
} {
  const invalid = () => new Error(strings.url.invalid);
  const m = /^mongodb(\+srv)?:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/i.exec(uri.trim());
  if (!m) throw invalid();
  const srv = m[1] !== undefined;
  const authority = m[2];
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  const hostList = (at >= 0 ? authority.slice(at + 1) : authority).split(",");
  const hosts = hostList.map(splitHost);
  if (hosts.some((h) => h === null) || hostList.some((h) => h === "")) throw invalid();
  const [first, ...rest] = hosts as [string, number | null][];
  if (srv && (rest.length > 0 || first[1] !== null)) throw invalid();

  const colon = userinfo.indexOf(":");
  const user = decode(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
  const password = colon >= 0 && userinfo.slice(colon + 1) !== "" ? decode(userinfo.slice(colon + 1)) : null;
  const database = decode(m[3] ?? "") || null;

  const ignored: string[] = [];
  const refused: string[] = [];
  const options: [string, string][] = [];
  let authSource: string | null = null;
  let mechanism: MongoAuth = "default";
  let replicaSet: string | null = null;
  let tls: boolean | null = null;
  let insecure = false;
  let caFile: string | null = null;
  const tlsOptions: string[] = [];
  for (const pair of (m[4] ?? "").split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = decode(eq >= 0 ? pair.slice(0, eq) : pair);
    const value = eq >= 0 ? decode(pair.slice(eq + 1)) : "";
    const lower = key.toLowerCase();
    if (lower === "tls" || lower === "ssl") tls = isTrue(value);
    else if (lower === "tlsinsecure" || lower === "tlsallowinvalidcertificates") {
      insecure ||= isTrue(value);
      if (isTrue(value)) tlsOptions.push(key);
    } else if (lower === "tlscafile") {
      caFile = value || null;
      if (caFile) tlsOptions.push(key);
    }
    else if (lower === "authsource") authSource = value || null;
    else if (lower === "replicaset") replicaSet = value || null;
    else if (lower === "authmechanism") {
      const found = MECHANISM[value.toUpperCase()];
      if (found) mechanism = found;
      else refused.push("authMechanism");
    } else if (lower.startsWith("autoencryption")) refused.push(key);
    else {
      const canonical = CANONICAL.get(lower);
      if (canonical === undefined) ignored.push(key);
      else if ((MONGO_REFUSED_OPTIONS as readonly string[]).includes(canonical)) refused.push(canonical);
      else options.push([canonical, value]);
    }
  }

  // Any TLS option implies TLS; an explicit tls=false next to one is a conflict.
  if (tls === false) for (const k of tlsOptions) refused.push(strings.url.mongoTlsConflict(k));
  const enabled = tls ?? (srv || insecure || caFile !== null);
  const mode: SslMode = !enabled ? "disable" : insecure ? "require" : "verifyFull";
  const mongo: MongoSettings = {
    srv,
    extraHosts: rest.map(([h, p]) => `${bracket(h)}:${p ?? DEFAULT_PORT}`),
    authSource: authSource ?? (mechanism === "plain" ? "$external" : (database ?? "admin")),
    authMechanism: mechanism,
    replicaSet,
    options,
  };
  return {
    patch: {
      kind: "mongoDb",
      host: first[0],
      port: first[1] ?? DEFAULT_PORT,
      user,
      database,
      sqlitePath: null,
      ssl: { mode, caFile, certFile: null, keyFile: null },
      ssh: null,
      mongo,
    },
    password,
    ignored,
    refused,
  };
}

/** The connection string of a MongoDB connection; it never contains a password. */
export function toMongoUri(cfg: ConnectionConfig): string {
  const mongo: MongoSettings = cfg.mongo ?? {
    srv: false,
    extraHosts: [],
    authSource: null,
    authMechanism: "default",
    replicaSet: null,
    options: [],
  };
  const primary = mongo.srv ? bracket(cfg.host) : `${bracket(cfg.host)}:${cfg.port}`;
  const hosts = [primary, ...mongo.extraHosts].join(",");
  const user = cfg.user ? `${encodeURIComponent(cfg.user)}@` : "";
  const db = cfg.database ? encodeURIComponent(cfg.database) : "";
  const authSource =
    mongo.authSource ?? (mongo.authMechanism === "plain" ? "$external" : (cfg.database ?? "admin"));
  const q = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`;
  const params = [q("authSource", authSource)];
  const mechanism = MECHANISM_NAME[mongo.authMechanism];
  if (mechanism) params.push(q("authMechanism", mechanism));
  if (mongo.replicaSet) params.push(q("replicaSet", mongo.replicaSet));
  const { mode } = cfg.ssl;
  params.push(mode === "disable" ? "tls=false" : "tls=true");
  if (mode === "require") params.push("tlsAllowInvalidCertificates=true");
  if (cfg.ssl.caFile && mode !== "disable") params.push(q("tlsCAFile", cfg.ssl.caFile));
  for (const [k, v] of mongo.options) params.push(q(k, v));
  return `mongodb${mongo.srv ? "+srv" : ""}://${user}${hosts}/${db}?${params.join("&")}`;
}
