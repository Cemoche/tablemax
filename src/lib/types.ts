// TypeScript mirrors of the Rust serde types (all camelCase on the wire).
// Sources: src-tauri/src/{value,error,store,manager}.rs and driver/mod.rs.
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
  | "invalid";

export interface AppError {
  kind: ErrorKind;
  message: string;
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

export interface ResultSet {
  columns: ColumnMeta[];
  rows: CellValue[][];
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
