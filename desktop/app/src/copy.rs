//! Every word the Mac client says, in one place.
//!
//! The same arrangement as `web/src/copy.ts`, and for the same reason: the one
//! thing that cannot be enumerated is "every string", so German survived two
//! translation passes in the web interface by sitting in markup where a reviewer
//! reading a diff about layout had no reason to look. `web/test/one-language.test.ts`
//! only walks `web/src`, so this tree needs the rule of its own — see
//! `tests/one_language.rs`.
//!
//! The panel's HTML therefore holds no words at all. Every label in it is an
//! empty element the panel fills from here, which is what makes the rule
//! checkable rather than aspirational.

use serde::Serialize;

/// The text the capture panel fills itself with.
#[derive(Debug, Clone, Serialize)]
pub struct Copy {
    pub placeholder: &'static str,
    pub send_hint: &'static str,
    pub sending: &'static str,
    pub unsent_on_escape: &'static str,
    pub sign_in_title: &'static str,
    pub account_label: &'static str,
    pub password_label: &'static str,
    pub sign_in_button: &'static str,
    pub wrong_credentials: &'static str,
    pub no_cookie: &'static str,
    pub signed_out: &'static str,
}

pub const COPY: Copy = Copy {
    placeholder: "A thought, into today",
    // Named rather than drawn, because the panel has no visible buttons and a
    // key combination nobody mentions is a key combination nobody finds.
    send_hint: "⌘↵ to save · esc to put it away · ⌘⌫ to discard",
    sending: "saving…",
    // The one case where the window refuses to go away. Hiding a panel that
    // still holds an unsent thought is how the thought would be lost quietly,
    // which is the single outcome this whole thing exists to prevent.
    unsent_on_escape: "not saved yet — ⌘↵ to try again, ⌘⌫ to discard it",
    sign_in_title: "Sign in to ndBrain",
    account_label: "Account",
    password_label: "Password",
    sign_in_button: "Sign in",
    wrong_credentials: "wrong name or password",
    // The trap from `CT 132 — ndBrain`, said out loud instead of turning into a
    // 401 on the next request with nothing to explain it.
    no_cookie: "signed in, but the server sent no session — is the address https?",
    signed_out: "signed out",
};

/// What the thought landed in. The path, because "saved" alone does not say
/// whether it went where it was meant to.
pub fn saved_in(path: &str, created: bool) -> String {
    if created {
        format!("started {path}")
    } else {
        format!("added to {path}")
    }
}

/// How long to wait, when the login brake said so.
pub fn slow_down(seconds: Option<u64>) -> String {
    match seconds {
        Some(seconds) => format!("too many attempts — try again in {seconds} s"),
        None => "too many attempts — try again shortly".to_string(),
    }
}

/* ---- the menu ----------------------------------------------------------- */

pub const MENU_OPEN: &str = "Open ndBrain in the browser";
pub const MENU_SIGN_OUT: &str = "Sign out";
pub const MENU_QUIT: &str = "Quit";
pub const TOOLTIP: &str = "ndBrain";

/// Said in the menu, not swallowed.
///
/// A global shortcut that is already taken fails to register, and this app has
/// no other reason to exist — so a silent failure here would leave somebody with
/// a menu-bar icon and no idea why nothing happens. The combination is named, so
/// it can be changed in the settings file.
pub fn shortcut_taken(combination: &str) -> String {
    format!("{combination} is taken by something else — change it in settings.json")
}

pub fn shortcut_ready(combination: &str) -> String {
    format!("Capture a thought  ({combination})")
}
