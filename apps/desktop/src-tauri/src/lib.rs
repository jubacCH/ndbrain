use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// Rejects anything that isn't a real, existing directory under the current
/// user's home, returning the canonicalized path on success.
///
/// This is the guard against Finding 2 of the plan-6 security review: `path`
/// here is an unvalidated string from the frontend, and it flows straight
/// into `Scope::allow_directory(path, true)` (recursive, and the fs command
/// permissions below are scope-less - see the doc comment on
/// `allow_local_notes_folder`). Without a check, a single
/// `invoke("allow_local_notes_folder", { path: "/" })` - e.g. via a future
/// XSS - would recursively grant read/write/remove over the entire
/// filesystem. Two checks narrow that down:
///
/// - `std::fs::metadata(..).is_dir()`: rejects non-existent paths and files
///   (the dialog plugin the frontend uses only ever returns existing
///   directories anyway, so this rejects nothing legitimate).
/// - `std::fs::canonicalize` + `starts_with(home_dir)`: resolves symlinks and
///   `..` components, then requires the result to be a **strict**
///   subdirectory of `$HOME` (`tauri::path::PathResolver::home_dir`, per the
///   Tauri v2 `Manager::path()` API). A personal notes folder is practically
///   always somewhere under the user's home; this turns the "allow /" worst
///   case into "allow some directory the OS user already has read/write
///   access to anyway", which is not a privilege escalation. `$HOME` itself
///   is rejected too (not just its ancestors) so a mistaken/malicious grant
///   can't sweep in dotfiles like `~/.ssh` alongside real notes.
fn validate_notes_folder(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
  let candidate = Path::new(path);

  let metadata = std::fs::metadata(candidate)
    .map_err(|e| format!("path does not exist or is not accessible: {e}"))?;
  if !metadata.is_dir() {
    return Err("path is not a directory".to_string());
  }

  let canonical = std::fs::canonicalize(candidate)
    .map_err(|e| format!("failed to resolve path: {e}"))?;

  let home = app
    .path()
    .home_dir()
    .map_err(|e| format!("failed to resolve home directory: {e}"))?;
  let home = std::fs::canonicalize(&home).unwrap_or(home);

  if canonical == home || !canonical.starts_with(&home) {
    return Err("notes folder must be inside your home directory".to_string());
  }

  Ok(canonical)
}

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
/// paths entirely up to this runtime `Scope`. `validate_notes_folder` above
/// is what keeps that scope from becoming "everywhere" in practice.
///
/// Callable from the frontend without any extra capability entry: Tauri v2's
/// ACL only gates plugin commands, not commands the app itself registers via
/// `invoke_handler`/`generate_handler!` (those are allowed to every window by
/// default - see the "Capabilities" chapter of the Tauri v2 docs).
///
/// Note on scope accumulation (M6 of the plan-6 review): switching to a new
/// folder does not revoke access to a previously-granted one for the rest of
/// the process's lifetime - `tauri::scope::fs::Scope` only exposes
/// `allow_directory`/`forbid_directory`, and `forbid_directory` is one-way
/// (there is no API to remove a forbidden pattern once added, and forbidden
/// always wins over allowed). Forbidding the old folder on every switch would
/// therefore permanently break re-selecting that same folder again later in
/// the same running session, with no fix short of restarting the app - a
/// worse footgun than the accumulation itself. This is a conscious
/// limitation: the runtime scope already resets on every app restart, and
/// `validate_notes_folder` bounds any accumulated entry to a subdirectory of
/// the user's own home directory either way.
#[tauri::command]
fn allow_local_notes_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let canonical = validate_notes_folder(&app, &path)?;
  app
    .fs_scope()
    .allow_directory(&canonical, true)
    .map_err(|e| e.to_string())
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
