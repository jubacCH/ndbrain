use tauri_plugin_fs::FsExt;

/// Extends the fs plugin's runtime scope to cover `path`, recursively.
///
/// The local-notes folder (`apps/web/src/local/localStore.ts`) is picked by
/// the user at runtime via the dialog plugin - it can be anywhere on disk, so
/// it cannot be expressed as a static glob in `capabilities/default.json` the
/// way `fs:default`'s built-in app-directory scope is. Tauri v2's answer for
/// exactly this case is `FsExt::fs_scope()` (an `AppHandle` extension trait
/// from `tauri-plugin-fs`), whose `Scope::allow_directory(path, recursive)`
/// grants runtime-only access - it does not persist across an app restart,
/// unlike the folder path itself (which the frontend re-grants on every
/// launch via this same command; see `LocalNotesStore.grantFolderAccess`'s
/// doc comment).
///
/// This only WORKS because the fs command permissions this app declares
/// (`fs:allow-read-text-file`, `-write-text-file`, `-mkdir`, `-read-dir`,
/// `-remove` in `capabilities/default.json`) are the scope-less "allow the
/// command everywhere" variants - they enable the commands themselves without
/// baking in any path restriction of their own, leaving the actual allowed
/// paths entirely up to this runtime `Scope`.
///
/// Callable from the frontend without any extra capability entry: Tauri v2's
/// ACL only gates plugin commands, not commands the app itself registers via
/// `invoke_handler`/`generate_handler!` (those are allowed to every window by
/// default - see the "Capabilities" chapter of the Tauri v2 docs).
#[tauri::command]
fn allow_local_notes_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
  app.fs_scope().allow_directory(&path, true).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .invoke_handler(tauri::generate_handler![allow_local_notes_folder])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
