//! The session token, in the Keychain and nowhere else.
//!
//! Why the Keychain and not a file beside `settings.json`: the token is a bearer
//! credential for the whole vault, and the project's rule is that a secret lives
//! in a secret store and is referred to by name everywhere else. On macOS that
//! store is the Keychain; the Vaultwarden the infrastructure uses is for secrets
//! that have to be reachable from a server, which this one does not.
//!
//! Why the token and not the password: a session can be ended from the server
//! (`sessions.destroy`, and a password change ends every one of them), a stored
//! password cannot. This client never keeps a password — it is read from the
//! panel, sent, and dropped.
//!
//! **One wrinkle of an unsigned build.** macOS binds a Keychain item to the
//! binary that created it by code signature. An ad-hoc-signed build gets a new
//! identity every time it is rebuilt, so the first capture after a rebuild asks
//! for permission again. Signing fixes it, and signing happens in Xcode.

use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

/// The Keychain service name. The bundle identifier, so an item is recognisable
/// in Keychain Access as belonging to this app.
const SERVICE: &str = "ch.b8n.ndbrain";

/// The stored session token for an account, if there is one.
pub fn session(account: &str) -> Option<String> {
    if account.is_empty() {
        return None;
    }
    let bytes = get_generic_password(SERVICE, account).ok()?;
    let token = String::from_utf8(bytes).ok()?;
    // An empty item is not a session. Treated as absent rather than sent, which
    // would be a request that 401s for no visible reason.
    if token.is_empty() {
        return None;
    }
    Some(token)
}

pub fn remember(account: &str, token: &str) -> Result<(), String> {
    set_generic_password(SERVICE, account, token.as_bytes()).map_err(|error| error.to_string())
}

/// Forgets the token. A missing item is success: the point is that it is gone.
pub fn forget(account: &str) {
    let _ = delete_generic_password(SERVICE, account);
}
