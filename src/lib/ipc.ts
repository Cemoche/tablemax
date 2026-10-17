// One function per Tauri command (names mirror src-tauri/src/commands.rs).
// Rejected promises carry an AppError (use toAppError from ./errors to normalise).
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ApplyOutcome,
  CellValue,
  ConnectionConfig,
  DbObject,
  ExecEvent,
  FilePurpose,
  Filter,
  ImportPreview,
  ImportResult,
  ObjectRef,
  PageRequest,
  ResultSet,
  RowChange,
  RowCount,
  RowKey,
  Settings,
  TableInfo,
  WorkspaceInfo,
} from "./types";

export const connectionsList = () => invoke<ConnectionConfig[]>("connections_list");

export const connectionSave = (
  config: ConnectionConfig,
  password: string | null,
  sshSecret: string | null,
) => invoke<ConnectionConfig>("connection_save", { config, password, sshSecret });

export const connectionDelete = (id: string) => invoke<void>("connection_delete", { id });

/**
 * Resolves with the server version string. `acceptFingerprint` trusts an unknown SSH
 * host key the user confirmed (the "SHA256:…" message of a hostKeyUnknown error).
 */
export const connectionTest = (
  config: ConnectionConfig,
  password: string | null,
  sshSecret: string | null,
  acceptFingerprint: string | null,
) => invoke<string>("connection_test", { config, password, sshSecret, acceptFingerprint });

export const workspaceOpen = (
  connectionId: string,
  password: string | null,
  sshSecret: string | null,
  acceptFingerprint: string | null,
) =>
  invoke<WorkspaceInfo>("workspace_open", { connectionId, password, sshSecret, acceptFingerprint });

/** Concrete host aliases of ~/.ssh/config. */
export const sshHostsList = () => invoke<string[]>("ssh_hosts_list");

/** Opens the native file picker (from Rust); null when cancelled. */
export const filePick = (purpose: FilePurpose) => invoke<string | null>("file_pick", { purpose });

/**
 * Reads a TablePlus export with `password`; null when the picker is cancelled. The file
 * is picked in Rust; `reusePick` re-reads the last picked file instead (a retry after a
 * wrong password). Rejects with invalid "wrong password or corrupted file" or
 * "not a TablePlus export".
 */
export const importTablePlusPreview = (password: string, reusePick: boolean) =>
  invoke<ImportPreview | null>("import_tableplus_preview", { password, reusePick });

/** Saves the previewed items at `indexes`; rejects with notFound "import expired". */
export const importTablePlusCommit = (importId: string, indexes: number[]) =>
  invoke<ImportResult>("import_tableplus_commit", { importId, indexes });

/** Drops a previewed import that will not be committed (and its secrets). */
export const importTablePlusDiscard = (importId: string) =>
  invoke<void>("import_tableplus_discard", { importId });

export const workspaceClose = (workspaceId: string) =>
  invoke<void>("workspace_close", { workspaceId });

export const schemasList = (workspaceId: string) =>
  invoke<string[]>("schemas_list", { workspaceId });

export const objectsList = (workspaceId: string, schema: string | null) =>
  invoke<DbObject[]>("objects_list", { workspaceId, schema });

export const tablePage = (workspaceId: string, request: PageRequest) =>
  invoke<ResultSet>("table_page", { workspaceId, request });

/** With filters, the count is capped (estimate 500,000 beyond). */
export const tableCount = (workspaceId: string, object: ObjectRef, filters: Filter[] = []) =>
  invoke<RowCount>("table_count", { workspaceId, object, filters });

/** Cached per workspace; `refresh` re-reads it from the database. */
export const tableInfo = (workspaceId: string, object: ObjectRef, refresh: boolean) =>
  invoke<TableInfo>("table_info", { workspaceId, object, refresh });

export const tableDdl = (workspaceId: string, object: ObjectRef) =>
  invoke<string>("table_ddl", { workspaceId, object });

/**
 * The SQL of each change, with literals inlined (display only, never run). Rejects with
 * invalid "change <i>: <reason>" (0-based) for a change that cannot be built.
 */
export const changesPreview = (workspaceId: string, object: ObjectRef, changes: RowChange[]) =>
  invoke<string[]>("changes_preview", { workspaceId, object, changes });

/**
 * Applies every change in one transaction on the browse connection (all or nothing).
 * Rejects with invalid "change <i>: <reason>" before running anything, cancelled (rolled
 * back), or connectionLost / connection (outcome unknown: COMMIT may have been sent).
 *
 * Safe mode: without `confirmed`, a commit the connection's safe mode wants confirmed is
 * rejected with confirmationRequired (message: the change indices, "0,1") before anything
 * is built or run; re-send it with `confirmed = true` once the user confirmed.
 */
export const changesApply = (
  workspaceId: string,
  object: ObjectRef,
  changes: RowChange[],
  confirmed = false,
) => invoke<ApplyOutcome>("changes_apply", { workspaceId, object, changes, confirmed });

/** Cancels the workspace's commit in flight (no-op when none): it rejects with cancelled. */
export const changesCancel = (workspaceId: string) =>
  invoke<void>("changes_cancel", { workspaceId });

/** The whole value of a cell (text/JSON never cut); notFound when the row is gone. */
export const cellValue = (workspaceId: string, object: ObjectRef, key: RowKey, column: string) =>
  invoke<CellValue>("cell_value", { workspaceId, object, key, column });

export const sqlSessionOpen = (workspaceId: string) =>
  invoke<string>("sql_session_open", { workspaceId });

export const sqlSessionClose = (sessionId: string) =>
  invoke<void>("sql_session_close", { sessionId });

/**
 * Runs statements, streaming ExecEvents to `onEvent`.
 * IMPORTANT: the end of the batch is the `batchFinished` event, NOT this promise
 * resolving. The promise settles after the backend sent `batchFinished` (or rejects
 * on a pre-flight error such as an unknown session or a query already running);
 * UI state must be driven by the events.
 * Safe mode: without `confirmed`, a batch the connection's safe mode wants confirmed
 * rejects with `confirmationRequired` before anything runs (no event is sent, not even
 * `batchFinished`); re-run it with `confirmed = true` once the user confirmed.
 */
export const sqlExecute = (
  sessionId: string,
  statements: string[],
  onEvent: (e: ExecEvent) => void,
  confirmed = false,
) => {
  const channel = new Channel<ExecEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("sql_execute", { sessionId, statements, confirmed, onEvent: channel });
};

export const sqlCancel = (sessionId: string) => invoke<void>("sql_cancel", { sessionId });

/** Sets the calling window's title (no JS permission needed: done in Rust). */
export const windowSetTitle = (title: string) => invoke<void>("window_set_title", { title });

export const settingsGet = () => invoke<Settings>("settings_get");

/** Saves the settings; resolves with the stored value (out-of-range numbers clamped). */
export const settingsSet = (settings: Settings) => invoke<Settings>("settings_set", { settings });

/** The app version (from the package info). */
export const appVersion = () => invoke<string>("app_version");
