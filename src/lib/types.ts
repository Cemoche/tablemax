// TypeScript mirrors of the Rust serde types (all camelCase on the wire).
// Sources: src-tauri/src/{value,error,store,manager,commands}.rs, driver/{mod,tls}.rs and
// import/{mod,tableplus}.rs.
// Pinned by types.shape.test.ts.

export type DriverKind = "postgres" | "mySql" | "mariaDb" | "sqlite";
export type Dialect = "postgres" | "mySql" | "sqlite";
export type EnvTag = "local" | "dev" | "staging" | "prod";
export type PasswordMode = "keyring" | "ask" | "none";

export type ErrorKind =
  | "connection"
  | "auth"
  | "query"
  | "cancelled"
  | "connectionLost"
  | "notFound"
  | "secret"
  | "io"
  | "invalid"
  /** SSH server key not in any known_hosts; message = its "SHA256:…" fingerprint. */
  | "hostKeyUnknown"
  /** SSH server key differs from known_hosts; message = the received fingerprint. */
  | "hostKeyChanged";

export interface AppError {
  kind: ErrorKind;
  message: string;
  /**
   * hostKeyUnknown / hostKeyChanged only: the SSH server ("host:port", after
   * ~/.ssh/config) whose key was checked. Absent on every other error.
   */
  host?: string;
}

export type CellValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: number }
  | { t: "bigInt"; v: string }
  | { t: "float"; v: number }
  | { t: "decimal"; v: string }
  | { t: "text"; v: string }
  | { t: "longText"; v: { preview: string; len: number } }
  | { t: "bytes"; v: { len: number; hexPreview: string } }
  | { t: "json"; v: string }
  | { t: "temporal"; v: string };

/** libpq-style TLS modes (driver/tls.rs). MySQL/MariaDB do not support verifyCa yet. */
export type SslMode = "disable" | "prefer" | "require" | "verifyCa" | "verifyFull";

export interface SslConfig {
  mode: SslMode;
  caFile: string | null;
  certFile: string | null;
  keyFile: string | null;
}

export type SshAuth = "password" | "key" | "agent";

/** SSH tunnel settings (store.rs SshSettings); no secret fields. */
export interface SshSettings {
  /** A ~/.ssh/config alias or a host name. */
  host: string;
  /** Overrides the config's Port (default 22). */
  port: number | null;
  /** Overrides the config's User. */
  user: string | null;
  auth: SshAuth;
  /** Private key for key auth; else the config's IdentityFile or ~/.ssh/id_*. */
  keyFile: string | null;
  /** Where the SSH password / key passphrase lives; always "none" for the agent. */
  secretMode: PasswordMode;
}

/** What file_pick picks a file for (commands.rs FilePurpose). */
export type FilePurpose = "caCert" | "clientCert" | "clientKey" | "sshKey" | "tableplusExport";

/**
 * Persisted connection settings (no secret fields).
 * `color` stores a swatch id "swatch-1".."swatch-6" (see SWATCHES), which maps to the
 * CSS variable `--swatch-N` in styles/tokens.css. `id` is "" for a not-yet-saved connection.
 */
export interface ConnectionConfig {
  id: string;
  name: string;
  color: string;
  envTag: EnvTag;
  kind: DriverKind;
  host: string;
  port: number;
  user: string;
  database: string | null;
  sqlitePath: string | null;
  passwordMode: PasswordMode;
  group: string | null;
  ssl: SslConfig;
  /** Database reached through this SSH server (host/port as seen from it). */
  ssh: SshSettings | null;
}

/** Something an import could not carry over as is (import/tableplus.rs ImportWarning). */
export interface ImportWarning {
  /** Name of the connection (or group) concerned. */
  entry: string;
  message: string;
}

/** One connection of a previewed import (import/mod.rs); never carries a secret. */
export interface ImportItem {
  /** Position in the pending import: what importTablePlusCommit takes. */
  index: number;
  /** `id` is "". */
  config: ConnectionConfig;
  hasPassword: boolean;
  hasSshSecret: boolean;
  /** Id of an existing connection with the same identity or the same name. */
  duplicateOf: string | null;
}

export interface ImportPreview {
  importId: string;
  items: ImportItem[];
  warnings: ImportWarning[];
}

export interface ImportResult {
  saved: ConnectionConfig[];
  /** E.g. secrets kept out of an unavailable keyring (saved in Ask mode). */
  warnings: ImportWarning[];
}

export const SWATCHES = [
  "swatch-1",
  "swatch-2",
  "swatch-3",
  "swatch-4",
  "swatch-5",
  "swatch-6",
] as const;

export interface ObjectRef {
  schema: string | null;
  name: string;
}

export type ObjectKind = "table" | "view";

export interface DbObject {
  schema: string | null;
  name: string;
  kind: ObjectKind;
}

export interface ColumnMeta {
  name: string;
  typeName: string;
}

/** Rows a SQL-tab statement returns at most (MAX_RESULT_ROWS in value.rs). */
export const MAX_RESULT_ROWS = 10_000;

export interface ResultSet {
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** The statement produced more than MAX_RESULT_ROWS rows; only the first ones are here. */
  truncated: boolean;
}

export interface StatementOutcome {
  result: ResultSet | null;
  rowsAffected: number | null;
  elapsedMs: number;
}

export type SortDir = "asc" | "desc";

export interface PageRequest {
  object: ObjectRef;
  limit: number;
  offset: number;
  sort: [string, SortDir] | null;
}

export type RowCount = { t: "exact"; v: number } | { t: "estimate"; v: number };

export interface WorkspaceInfo {
  workspaceId: string;
  connectionId: string;
  dialect: Dialect;
  serverVersion: string;
}

export type ExecEvent =
  | { event: "statementStarted"; data: { index: number } }
  | { event: "statementFinished"; data: { index: number; outcome: StatementOutcome } }
  | { event: "statementFailed"; data: { index: number; error: AppError } }
  | { event: "batchFinished"; data: { cancelled: boolean } };

// ---- Query history and saved queries (history.rs / saved_queries.rs) ----

export interface HistoryEntry {
  id: number;
  connectionId: string;
  sql: string;
  /** Milliseconds since the Unix epoch. */
  executedAt: number;
  elapsedMs: number | null;
  /** Rows returned, or rows touched by a write. */
  rows: number | null;
  error: string | null;
}

export interface SavedQuery {
  /** File name without the `.sql` extension. */
  name: string;
  /** Milliseconds since the Unix epoch. */
  modifiedAt: number;
  size: number;
}
