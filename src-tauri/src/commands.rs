//! Tauri commands: thin async wrappers over [`SessionManager`]. Names and parameter
//! names are the frontend contract (Tauri exposes snake_case params as camelCase).

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::driver::{DbObject, ObjectRef, PageRequest, ResultSet, RowCount};
use crate::error::{AppError, AppResult, ErrorKind};
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
    ssh_secret: Option<String>,
) -> AppResult<ConnectionConfig> {
    state.save_connection(config, password, ssh_secret).await
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
    ssh_secret: Option<String>,
    accept_fingerprint: Option<String>,
) -> AppResult<String> {
    state
        .test_connection(&config, password, ssh_secret, accept_fingerprint)
        .await
}

#[tauri::command]
pub async fn workspace_open(
    state: State<'_, SessionManager>,
    connection_id: String,
    password: Option<String>,
    ssh_secret: Option<String>,
    accept_fingerprint: Option<String>,
) -> AppResult<WorkspaceInfo> {
    state
        .open_workspace(&connection_id, password, ssh_secret, accept_fingerprint)
        .await
}

/// Concrete host aliases of `~/.ssh/config` (suggestions for the SSH host field).
#[tauri::command]
pub async fn ssh_hosts_list(state: State<'_, SessionManager>) -> AppResult<Vec<String>> {
    state.ssh_hosts().await
}

/// What a file is picked for; decides the dialog's filter and starting folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilePurpose {
    CaCert,
    ClientCert,
    ClientKey,
    SshKey,
    TableplusExport,
}

/// Dialog filter (`None` = any file) and whether the dialog starts in `~/.ssh`.
fn picker_spec(purpose: FilePurpose) -> (Option<(&'static str, &'static [&'static str])>, bool) {
    const CERTS: &[&str] = &["pem", "crt", "cer"];
    match purpose {
        FilePurpose::CaCert | FilePurpose::ClientCert => (Some(("Certificates", CERTS)), false),
        FilePurpose::ClientKey => (Some(("Private keys", &["pem", "key"])), false),
        FilePurpose::SshKey => (None, true),
        FilePurpose::TableplusExport => {
            (Some(("TablePlus export", &["tableplusconnection"])), false)
        }
    }
}

/// Opens the native file picker (from Rust: the webview has no dialog/fs permission)
/// and returns the chosen path, or `None` when cancelled.
#[tauri::command]
pub async fn file_pick(app: AppHandle, purpose: FilePurpose) -> AppResult<Option<String>> {
    let (filter, in_ssh_dir) = picker_spec(purpose);
    let mut dialog = app.dialog().file();
    if let Some((name, extensions)) = filter {
        dialog = dialog.add_filter(name, extensions);
    }
    if in_ssh_dir && let Ok(home) = app.path().home_dir() {
        let ssh = home.join(".ssh");
        if ssh.is_dir() {
            dialog = dialog.set_directory(ssh);
        }
    }
    let picked = tokio::task::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?;
    picked
        .map(|p| {
            p.into_path()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| AppError::new(ErrorKind::Io, format!("unusable file path: {e}")))
        })
        .transpose()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_purpose_serde_names() {
        let p = |s: &str| serde_json::from_value::<FilePurpose>(serde_json::json!(s)).unwrap();
        assert_eq!(p("caCert"), FilePurpose::CaCert);
        assert_eq!(p("clientCert"), FilePurpose::ClientCert);
        assert_eq!(p("clientKey"), FilePurpose::ClientKey);
        assert_eq!(p("sshKey"), FilePurpose::SshKey);
        assert_eq!(p("tableplusExport"), FilePurpose::TableplusExport);
    }

    #[test]
    fn picker_filters_per_purpose() {
        let exts = |p| picker_spec(p).0.map(|(_, e)| e.to_vec());
        assert_eq!(exts(FilePurpose::CaCert), Some(vec!["pem", "crt", "cer"]));
        assert_eq!(
            exts(FilePurpose::ClientCert),
            Some(vec!["pem", "crt", "cer"])
        );
        assert_eq!(exts(FilePurpose::ClientKey), Some(vec!["pem", "key"]));
        assert_eq!(exts(FilePurpose::SshKey), None);
        assert_eq!(
            exts(FilePurpose::TableplusExport),
            Some(vec!["tableplusconnection"])
        );
        assert!(
            picker_spec(FilePurpose::SshKey).1,
            "SSH keys start in ~/.ssh"
        );
        assert!(!picker_spec(FilePurpose::CaCert).1);
    }
}
