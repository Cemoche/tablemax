pub mod commands;
pub mod driver;
pub mod error;
pub mod manager;
pub mod secrets;
pub mod store;
pub mod value;

use std::sync::Arc;

use tauri::Manager;

use crate::manager::SessionManager;
use crate::secrets::KeyringSecretStore;
use crate::store::ConnectionStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = ConnectionStore::open(&dir.join("app.db"))?;
            app.manage(SessionManager::new(
                Arc::new(store),
                Arc::new(KeyringSecretStore),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections_list,
            commands::connection_save,
            commands::connection_delete,
            commands::connection_test,
            commands::workspace_open,
            commands::workspace_close,
            commands::schemas_list,
            commands::objects_list,
            commands::table_page,
            commands::table_count,
            commands::sql_session_open,
            commands::sql_session_close,
            commands::sql_execute,
            commands::sql_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
