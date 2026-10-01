//! Where the server is, which key opens the panel, and whose account it is.
//!
//! A file rather than a preferences window: three values, changed about once,
//! and a window for them would be more interface than the whole app has. None of
//! the three is a secret — the session token is in the Keychain, see
//! `keychain.rs` — so this is plain JSON on disk, and the comment in it says so.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// `https://ndbrain.b8n.ch`, which is the only address this is ever pointed at.
///
/// The internal `http://10.10.30.98:3000` deliberately does not work: see
/// `CT 132 — ndBrain`. `base_url` in `ndbrain-capture` refuses it, because a
/// native client would otherwise put the session token on the wire in clear.
pub const DEFAULT_ADDRESS: &str = "https://ndbrain.b8n.ch";

/// The combination the panel answers to.
///
/// Space rather than a letter: every letter with ⌘⇧ on it is some application's
/// own shortcut, and a global registration that silently loses to the front app
/// is worse than one that fails loudly.
pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    #[serde(default = "default_address")]
    pub address: String,
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    /// Remembered so the sign-in field is filled in and the Keychain knows which
    /// item to look for. A name, not a credential.
    #[serde(default)]
    pub account: String,
}

fn default_address() -> String {
    DEFAULT_ADDRESS.to_string()
}

fn default_shortcut() -> String {
    DEFAULT_SHORTCUT.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self { address: default_address(), shortcut: default_shortcut(), account: String::new() }
    }
}

impl Settings {
    /// Reads the file, falling back to the defaults for anything it does not say.
    ///
    /// A broken file is the defaults rather than a refusal to start: this app's
    /// whole job is to be there when a thought arrives, and a JSON typo is not a
    /// reason to be absent. What was wrong is returned alongside so the caller
    /// can say it out loud instead of swallowing it.
    pub fn read(path: &Path) -> (Self, Option<String>) {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            // Not there yet is the ordinary first run, not a problem.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return (Self::default(), None)
            }
            Err(error) => return (Self::default(), Some(error.to_string())),
        };

        match serde_json::from_str::<Self>(&text) {
            Ok(settings) => (settings, None),
            Err(error) => (Self::default(), Some(error.to_string())),
        }
    }

    pub fn write(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(self).unwrap_or_default()))
    }
}

/// `~/Library/Application Support/ch.b8n.ndbrain/settings.json`.
pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}
