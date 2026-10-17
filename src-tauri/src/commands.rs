//! Tauri commands: thin async wrappers over [`SessionManager`]. Names and parameter
//! names are the frontend contract (Tauri exposes snake_case params as camelCase).

use std::path::PathBuf;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::driver::{DbObject, ObjectRef, PageRequest, ResultSet, RowCount};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::import::{ImportPreview, ImportResult};
use crate::manager::{ExecEvent, SessionManager, WorkspaceInfo};
use crate::settings::{self, Settings};
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
    pick_file(&app, purpose).await
}

/// Reads a TablePlus export with `password` (`None` when the picker is cancelled). The
/// file comes from the native picker, or with `reuse_pick` (a retry after a wrong
/// password) from the last pick, remembered server-side. Secrets stay in the backend
/// until `import_tableplus_commit`.
#[tauri::command]
pub async fn import_tableplus_preview(
    app: AppHandle,
    state: State<'_, SessionManager>,
    password: String,
    reuse_pick: bool,
) -> AppResult<Option<ImportPreview>> {
    let pick = || async {
        let path = pick_file(&app, FilePurpose::TableplusExport).await?;
        Ok(path.map(PathBuf::from))
    };
    state
        .import_tableplus_preview_picked(password, reuse_pick, pick)
        .await
}

/// Drops a previewed import that will not be committed (its secrets with it).
#[tauri::command]
pub async fn import_tableplus_discard(
    state: State<'_, SessionManager>,
    import_id: String,
) -> AppResult<()> {
    state.import_tableplus_discard(&import_id);
    Ok(())
}

/// Saves the previewed entries at `indexes` (positions in the preview's `items`).
#[tauri::command]
pub async fn import_tableplus_commit(
    state: State<'_, SessionManager>,
    import_id: String,
    indexes: Vec<usize>,
) -> AppResult<ImportResult> {
    state.import_tableplus_commit(&import_id, &indexes).await
}

/// The native file picker, run off the async threads; `None` when cancelled.
async fn pick_file(app: &AppHandle, purpose: FilePurpose) -> AppResult<Option<String>> {
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
    state.browse(&workspace_id).await?.list_schemas().await
}

#[tauri::command]
pub async fn objects_list(
    state: State<'_, SessionManager>,
    workspace_id: String,
    schema: Option<String>,
) -> AppResult<Vec<DbObject>> {
    state
        .browse(&workspace_id)
        .await?
        .list_objects(schema.as_deref())
        .await
}

#[tauri::command]
pub async fn table_page(
    state: State<'_, SessionManager>,
    workspace_id: String,
    request: PageRequest,
) -> AppResult<ResultSet> {
    state
        .browse(&workspace_id)
        .await?
        .fetch_page(&request)
        .await
}

#[tauri::command]
pub async fn table_count(
    state: State<'_, SessionManager>,
    workspace_id: String,
    object: ObjectRef,
) -> AppResult<RowCount> {
    state
        .browse(&workspace_id)
        .await?
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
/// Rejects with `ConfirmationRequired` (no event, nothing run) when the connection's
/// safe mode wants the batch confirmed and `confirmed` is false.
#[tauri::command]
pub async fn sql_execute(
    state: State<'_, SessionManager>,
    session_id: String,
    statements: Vec<String>,
    confirmed: bool,
    on_event: Channel<ExecEvent>,
) -> AppResult<()> {
    // `confirmed`: the user confirmed this batch in the safe mode dialog. Which
    // statements need it is decided by the backend from the stored connection.
    state
        .execute_batch(&session_id, statements, confirmed, move |event| {
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

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub async fn settings_get(app: AppHandle) -> AppResult<Settings> {
    let path = settings_path(&app)?;
    tokio::task::spawn_blocking(move || settings::load(&path))
        .await
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))
}

/// Saves the settings and returns the stored value (out-of-range numbers clamped).
#[tauri::command]
pub async fn settings_set(app: AppHandle, settings: Settings) -> AppResult<Settings> {
    let path = settings_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let clamped = settings.clamped();
        settings::save(&path, &clamped)?;
        Ok(clamped)
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

/// Sets the title of the calling window (`TableMax — <connection> [PROD]`). Done here
/// rather than from JS so the capabilities stay at `core:default`.
#[tauri::command]
pub fn window_set_title(window: tauri::WebviewWindow, title: String) -> AppResult<()> {
    window
        .set_title(&title)
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))
}
