// TypeScript mirrors of the Rust serde types (all camelCase on the wire).
// Sources: src-tauri/src/{value,error,store,manager,commands}.rs,
// driver/{mod,tls,meta,query,dml}.rs and import/{mod,tableplus}.rs.
// Pinned by types.shape.test.ts.

export type DriverKind = "postgres" | "mySql" | "mariaDb" | "sqlite";
export type Dialect = "postgres" | "mySql" | "sqlite";
export type EnvTag = "local" | "dev" | "staging" | "prod";
export type PasswordMode = "keyring" | "ask" | "none";
/**
 * Safe mode of a connection (store.rs SafeMode): which statements are confirmed before
 * a batch runs. A connection's `null` (Default, by environment) is confirmWrites on prod
 * and off otherwise, decided by the backend.
 */
export type SafeMode = "off" | "confirmAll" | "confirmWrites";

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
  | "hostKeyChanged"
  /**
   * Safe mode: nothing of the batch ran; message = the indices of the statements to
   * confirm, comma-separated ("1", "0,2"). Re-run it with `confirmed`.
   */
  | "confirmationRequired";

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
  /** null or absent: Default (by environment). */
  safeMode?: SafeMode | null;
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

/** driver/query.rs FilterOp. */
export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "in"
  | "notIn"
  | "between"
  | "notBetween"
  | "like"
  | "notLike"
  /** PostgreSQL only (LIKE elsewhere). */
  | "ilike"
  | "contains"
  | "notContains"
  | "isNull"
  | "isNotNull"
  /** `values[0]` is the user's own SQL, written as is between parentheses. */
  | "raw";

export interface Filter {
  /** null = any column (eq, contains, notContains, like only). */
  column: string | null;
  op: FilterOp;
  values: string[];
}

export interface PageRequest {
  object: ObjectRef;
  limit: number;
  offset: number;
  sort: [string, SortDir] | null;
  /** Joined by AND. */
  filters: Filter[];
}

/** driver/meta.rs ColumnInfo. */
export interface ColumnInfo {
  name: string;
  /** PostgreSQL: format_type; MySQL/MariaDB: COLUMN_TYPE; SQLite: the declared type. */
  typeName: string;
  /** The type without its modifier (what values are cast to). */
  baseType: string;
  nullable: boolean;
  /** The default as an SQL expression; null without a default or with DEFAULT NULL. */
  default: string | null;
  /** serial / identity / AUTO_INCREMENT / SQLite INTEGER PRIMARY KEY. */
  autoIncrement: boolean;
  /** Generated (computed) column: never editable. */
  generated: boolean;
  /** Holds bytes (bytea and domains over it, binary/varbinary/blob/bit/geometry, SQLite BLOB): read-only in v1. */
  binary: boolean;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableInfo {
  object: ObjectRef;
  kind: ObjectKind;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** Columns identifying one row (primary key, else a unique NOT NULL index); null = read-only. */
  rowKey: string[] | null;
  hasRowid: boolean;
}

/** driver/dml.rs EditValue: `default` (the column's default) only in an insert. */
export type EditValue = { t: "null" } | { t: "default" } | { t: "text"; v: string };

/** The loaded values of the row key columns, as [column, value] pairs. */
export type RowKey = [string, CellValue][];

export type RowChange =
  | { kind: "update"; key: RowKey; set: [string, EditValue][] }
  | { kind: "insert"; values: [string, EditValue][] }
  | { kind: "delete"; key: RowKey };

/**
 * Result of changes_apply. Not applied: everything was rolled back; `failedIndex` is the
 * change that failed, null when the commit itself failed.
 */
export interface ApplyOutcome {
  applied: boolean;
  /** Rows touched by each statement that ran (the failed one included). */
  affected: number[];
  failedIndex: number | null;
  error: AppError | null;
}

export type RowCount = { t: "exact"; v: number } | { t: "estimate"; v: number };

/** What the interface may offer on a connection (driver::Capabilities). */
export interface Capabilities {
  sqlEditor: boolean;
  gridEditing: boolean;
  routines: boolean;
  ddl: boolean;
  foreignKeys: boolean;
  documents: boolean;
  /** The workspace can move to another database (PostgreSQL). */
  databaseSwitch: boolean;
}

export interface WorkspaceInfo {
  workspaceId: string;
  connectionId: string;
  /** Null for a connection without SQL (documents). */
  dialect: Dialect | null;
  capabilities: Capabilities;
  serverVersion: string;
  /** Database the browse connection is on; null when unknown or not applicable. */
  database: string | null;
}

export type ExecEvent =
  | { event: "statementStarted"; data: { index: number } }
  | { event: "statementFinished"; data: { index: number; outcome: StatementOutcome } }
  | { event: "statementFailed"; data: { index: number; error: AppError } }
  | { event: "batchFinished"; data: { cancelled: boolean } };

// settings.rs (camelCase on the wire).
export type ThemeSetting = "system" | "light" | "dark";

export interface Settings {
  version: number;
  theme: ThemeSetting;
  /** "" = use the --font-mono token. */
  editorFontFamily: string;
  editorFontSize: number;
  pageSize: number;
  exactCountThreshold: number;
  autoLimitDefault: boolean;
  autoLimitValue: number;
  /** Action id to shortcut; empty = defaults. */
  keymap: Record<string, string>;
}

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

// ---- Completion catalog and routines (driver/catalog.rs) ----

export interface CatalogColumn {
  name: string;
  typeName: string;
}

export interface CatalogTable {
  name: string;
  /** Same values as DbObject.kind. */
  kind: DbObject["kind"];
  /** In definition order. */
  columns: CatalogColumn[];
}

export interface Catalog {
  schema: string | null;
  /** Sorted by name. */
  tables: CatalogTable[];
}

export type RoutineKind = "function" | "procedure";

export interface DbRoutine {
  schema: string | null;
  name: string;
  kind: RoutineKind;
}
