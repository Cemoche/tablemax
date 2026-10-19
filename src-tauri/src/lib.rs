pub mod close_gate;
pub mod commands;
pub mod driver;
pub mod error;
pub mod flags;
pub mod history;
pub mod import;
pub mod manager;
pub mod migrate;
pub mod safety;
pub mod saved_queries;
pub mod secrets;
pub mod session_state;
pub mod settings;
pub mod ssh;
pub mod store;
pub mod value;

use std::sync::Arc;

use tauri::{Emitter, Manager};

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
            // Before anything opens the data: an install from an earlier identifier keeps its
            // connections, settings and queries. A failure leaves the old directory intact.
            let moved_from = match migrate::migrate_data_dir(&dir, migrate::PREVIOUS_IDENTIFIERS) {
                Ok(migrate::Outcome::Moved { from, left, .. }) => {
                    if left > 0 {
                        eprintln!(
                            "tablemax: moved data from {} ({left} entries already existed and stayed there)",
                            from.display()
                        );
                    }
                    Some(from)
                }
                Ok(migrate::Outcome::NothingToDo) => None,
                Err(e) => {
                    eprintln!("tablemax: could not move the previous data directory: {e}");
                    None
                }
            };
            let store = ConnectionStore::open(&dir.join("app.db"))?;
            if let Some(from) = moved_from
                && let Err(e) = migrate::rebase_sqlite_paths(&store, &from, &dir)
            {
                eprintln!("tablemax: could not update SQLite paths after the move: {}", e.message);
            }
            let known_hosts = KnownHosts {
                system: app
                    .path()
                    .home_dir()
                    .ok()
                    .map(|home| home.join(".ssh").join("known_hosts")),
                app: dir.join("known_hosts"),
            };
            app.manage(
                SessionManager::new(Arc::new(store), Arc::new(KeyringSecretStore), known_hosts)
                    .with_queries_dir(dir.join("queries")),
            );
            app.manage(close_gate::CloseGate::default());
            // The frameless window's saved interface size and title bar choice, applied
            // before the page shows.
            if let Some(main) = app.get_webview_window("main") {
                commands::apply_window_settings(&main, &settings::load(&dir.join("settings.json")));
            }
            Ok(())
        })
        // Closing the main window waits for the frontend to flush its session (see
        // `close_gate`); a 2 s fallback closes anyway.
        .on_window_event(|window, event| {
            use close_gate::{CLOSE_FALLBACK, CloseDecision, CloseGate, FLUSH_EVENT};
            if window.label() != "main" {
                return;
            }
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let gate = window.state::<CloseGate>();
            match gate.on_close_requested() {
                CloseDecision::Allow => {}
                CloseDecision::Defer { first } => {
                    api.prevent_close();
                    if first {
                        let _ = window.emit(FLUSH_EVENT, ());
                        let w = window.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(CLOSE_FALLBACK).await;
                            if w.state::<CloseGate>().confirm() {
                                let _ = w.close();
                            }
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_flags,
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
            commands::table_info,
            commands::table_ddl,
            commands::changes_preview,
            commands::changes_apply,
            commands::changes_cancel,
            commands::cell_value,
            commands::sql_session_open,
            commands::sql_session_close,
            commands::sql_execute,
            commands::sql_cancel,
            commands::settings_get,
            commands::settings_set,
            commands::window_set_title,
            commands::window_set_zoom,
            commands::app_version,
            commands::history_list,
            commands::history_clear,
            commands::session_save,
            commands::session_load,
            commands::saved_queries_list,
            commands::saved_query_read,
            commands::saved_query_write,
            commands::saved_query_rename,
            commands::saved_query_delete,
            commands::catalog_get,
            commands::routines_list,
            commands::databases_list,
            commands::workspace_switch_database,
            commands::window_close_confirmed,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_is_maximized,
            commands::window_start_drag,
            commands::window_start_resize,
            commands::window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
