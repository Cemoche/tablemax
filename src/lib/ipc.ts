// One function per Tauri command (names mirror src-tauri/src/commands.rs).
// Rejected promises carry an AppError (use toAppError from ./errors to normalise).
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ConnectionConfig,
  DbObject,
  ExecEvent,
  FilePurpose,
  ObjectRef,
  PageRequest,
  ResultSet,
  RowCount,
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

export const workspaceClose = (workspaceId: string) =>
  invoke<void>("workspace_close", { workspaceId });

export const schemasList = (workspaceId: string) =>
  invoke<string[]>("schemas_list", { workspaceId });

export const objectsList = (workspaceId: string, schema: string | null) =>
  invoke<DbObject[]>("objects_list", { workspaceId, schema });

export const tablePage = (workspaceId: string, request: PageRequest) =>
  invoke<ResultSet>("table_page", { workspaceId, request });

export const tableCount = (workspaceId: string, object: ObjectRef) =>
  invoke<RowCount>("table_count", { workspaceId, object });

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
 */
export const sqlExecute = (
  sessionId: string,
  statements: string[],
  onEvent: (e: ExecEvent) => void,
) => {
  const channel = new Channel<ExecEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("sql_execute", { sessionId, statements, onEvent: channel });
};

export const sqlCancel = (sessionId: string) => invoke<void>("sql_cancel", { sessionId });
