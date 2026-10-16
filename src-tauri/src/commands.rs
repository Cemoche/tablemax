//! Tauri commands: thin async wrappers over [`SessionManager`]. Names and parameter
//! names are the frontend contract (Tauri exposes snake_case params as camelCase).

use tauri::State;
use tauri::ipc::Channel;

use crate::driver::{DbObject, ObjectRef, PageRequest, ResultSet, RowCount};
use crate::error::AppResult;
use crate::manager::{ExecEvent, SessionManager, WorkspaceInfo};
use crate::store::ConnectionConfig;
use crate::value::EXACT_COUNT_THRESHOLD;

#[tauri::command]
pub async fn connections_list(
    state: State<'_, SessionManager>,
) -> AppResult<Vec<ConnectionConfig>> {
    state.list_connections().await
}

#[tauri::command]
pub async fn connection_save(
    state: State<'_, SessionManager>,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<ConnectionConfig> {
    state.save_connection(config, password).await
}

#[tauri::command]
pub async fn connection_delete(state: State<'_, SessionManager>, id: String) -> AppResult<()> {
    state.delete_connection(&id).await
}

#[tauri::command]
pub async fn connection_test(
    state: State<'_, SessionManager>,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<String> {
    state.test_connection(&config, password).await
}

#[tauri::command]
pub async fn workspace_open(
    state: State<'_, SessionManager>,
    connection_id: String,
    password: Option<String>,
) -> AppResult<WorkspaceInfo> {
    state.open_workspace(&connection_id, password).await
}

#[tauri::command]
pub async fn workspace_close(
    state: State<'_, SessionManager>,
    workspace_id: String,
) -> AppResult<()> {
    state.close_workspace(&workspace_id).await
}

#[tauri::command]
pub async fn schemas_list(
    state: State<'_, SessionManager>,
    workspace_id: String,
) -> AppResult<Vec<String>> {
    state.browse(&workspace_id)?.list_schemas().await
}

#[tauri::command]
pub async fn objects_list(
    state: State<'_, SessionManager>,
    workspace_id: String,
    schema: Option<String>,
) -> AppResult<Vec<DbObject>> {
    state
        .browse(&workspace_id)?
        .list_objects(schema.as_deref())
        .await
}

#[tauri::command]
pub async fn table_page(
    state: State<'_, SessionManager>,
    workspace_id: String,
    request: PageRequest,
) -> AppResult<ResultSet> {
    state.browse(&workspace_id)?.fetch_page(&request).await
}

#[tauri::command]
pub async fn table_count(
    state: State<'_, SessionManager>,
    workspace_id: String,
    object: ObjectRef,
) -> AppResult<RowCount> {
    state
        .browse(&workspace_id)?
        .count_rows(&object, EXACT_COUNT_THRESHOLD)
        .await
}

#[tauri::command]
pub async fn sql_session_open(
    state: State<'_, SessionManager>,
    workspace_id: String,
) -> AppResult<String> {
    state.open_sql_session(&workspace_id).await
}

#[tauri::command]
pub async fn sql_session_close(
    state: State<'_, SessionManager>,
    session_id: String,
) -> AppResult<()> {
    state.close_sql_session(&session_id).await
}

/// Streams [`ExecEvent`]s on `on_event`; resolves once `BatchFinished` was sent.
#[tauri::command]
pub async fn sql_execute(
    state: State<'_, SessionManager>,
    session_id: String,
    statements: Vec<String>,
    on_event: Channel<ExecEvent>,
) -> AppResult<()> {
    state
        .execute_batch(&session_id, statements, move |event| {
            // A closed webview just drops the event; the batch still runs to completion.
            let _ = on_event.send(event);
        })
        .await
}

#[tauri::command]
pub async fn sql_cancel(state: State<'_, SessionManager>, session_id: String) -> AppResult<()> {
    state.cancel(&session_id).await
}
