pub mod commands;
pub mod driver;
pub mod error;
pub mod import;
pub mod manager;
pub mod safety;
pub mod secrets;
pub mod settings;
pub mod ssh;
pub mod store;
pub mod value;

use std::sync::Arc;

use tauri::Manager;

use crate::manager::SessionManager;
use crate::secrets::KeyringSecretStore;
use crate::ssh::known_hosts::KnownHosts;
use crate::store::ConnectionStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    driver::tls::install_crypto_provider();
    tauri::Builder::default()
        // File pickers are opened from Rust only (`commands::file_pick`): no dialog
        // permission is granted to the webview.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = ConnectionStore::open(&dir.join("app.db"))?;
            let known_hosts = KnownHosts {
                system: app
                    .path()
                    .home_dir()
                    .ok()
                    .map(|home| home.join(".ssh").join("known_hosts")),
                app: dir.join("known_hosts"),
            };
            app.manage(SessionManager::new(
                Arc::new(store),
                Arc::new(KeyringSecretStore),
                known_hosts,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections_list,
            commands::connection_save,
            commands::connection_delete,
            commands::connection_test,
            commands::workspace_open,
            commands::ssh_hosts_list,
            commands::file_pick,
            commands::import_tableplus_preview,
            commands::import_tableplus_commit,
            commands::import_tableplus_discard,
            commands::workspace_close,
            commands::schemas_list,
            commands::objects_list,
            commands::table_page,
            commands::table_count,
            commands::sql_session_open,
            commands::sql_session_close,
            commands::sql_execute,
            commands::sql_cancel,
            commands::settings_get,
            commands::settings_set,
            commands::window_set_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
