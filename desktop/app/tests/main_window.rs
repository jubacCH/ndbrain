//! The window that makes this an application, and the three objections to it.
//!
//! The original build deliberately had no WebView, and gave three reasons: a
//! second place to be signed in, a second cache to go stale, a second
//! content-security policy. The window exists now because the product wanted is
//! ndBrain rather than a shortcut that starts a browser — so the reasons are
//! answered, and this file holds the parts of the answer that can be asserted
//! without a running WebView.

use ndbrain_capture::SESSION_COOKIE;
use ndbrain_desktop::{presence_for, session_cookie, Presence};

/* ---- one place to be signed in ------------------------------------------ */

/// The cookie put into the WebView is the one the server would have set.
///
/// Three things have to be right or the injection looks like the WebView
/// ignoring it: the name, the domain (`wry` only hands a cookie to a URL whose
/// domain matches exactly), and the path.
#[test]
fn hands_the_webview_the_cookie_the_server_would_have_set() {
    let cookie = session_cookie("https://ndbrain.b8n.ch", "deadbeef").expect("a cookie");

    assert_eq!(cookie.name(), SESSION_COOKIE);
    assert_eq!(cookie.value(), "deadbeef");
    assert_eq!(cookie.domain(), Some("ndbrain.b8n.ch"));
    assert_eq!(cookie.path(), Some("/"));
    assert_eq!(cookie.http_only(), Some(true));
}

/// `Secure` follows the address, because `base_url` admits one plain-HTTP case.
///
/// A `Secure` cookie is not sent over `http://`, so hard-coding it would make a
/// loopback development server look as though the injection had silently failed
/// — the page would simply show its login screen.
#[test]
fn marks_the_cookie_secure_for_https_and_not_for_loopback() {
    let published = session_cookie("https://ndbrain.b8n.ch", "t").unwrap();
    assert_eq!(published.secure(), Some(true));

    let local = session_cookie("http://localhost:3000", "t").unwrap();
    assert_eq!(local.secure(), Some(false));
    assert_eq!(local.domain(), Some("localhost"));
}

/// No expiry of our own.
///
/// The server's session has a lifetime this process does not know. Inventing a
/// date would either end the window's session before the server did or leave a
/// cookie behind that the server has already forgotten, and a cookie that looks
/// present and 401s is the failure this project names in `session_token`.
#[test]
fn invents_no_expiry_for_a_session_it_did_not_issue() {
    let cookie = session_cookie("https://ndbrain.b8n.ch", "t").unwrap();

    assert_eq!(cookie.expires(), None);
    assert_eq!(cookie.max_age(), None);
}

/// An address `base_url` refuses produces no cookie rather than a cookie for
/// nowhere.
#[test]
fn refuses_to_build_a_cookie_for_an_address_it_would_not_talk_to() {
    assert!(session_cookie("http://10.10.30.98:3000", "t").is_none());
    assert!(session_cookie("ndbrain.b8n.ch", "t").is_none());
    assert!(session_cookie("", "t").is_none());
}

/* ---- the served page cannot call into this process ---------------------- */

/// The main window is outside the IPC capability, and that is the whole of the
/// third objection's answer.
///
/// Tauri's own `csp` applies to what Tauri serves, which here is the capture
/// panel; the main window is remote content and keeps the policy the server
/// sends with it, so there is no second policy to maintain. What there would be,
/// if this file named `main`, is a page served over the network holding the
/// right to invoke `capture` and `sign_in` in a native process. It does not.
#[test]
fn gives_the_served_page_no_access_to_the_commands() {
    let capabilities: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();

    let windows = capabilities["windows"].as_array().expect("a windows list");
    assert_eq!(windows, &[serde_json::Value::String("capture".into())]);
}

/// Both windows are built in Rust, so neither is described twice.
///
/// A window in `tauri.conf.json` would be created before `setup` runs, which is
/// before the settings file has been read — so the main window would open at
/// whatever address the configuration named rather than the configured one, and
/// nothing would say which of the two won.
#[test]
fn describes_no_window_in_the_configuration() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();

    assert_eq!(config["app"]["windows"].as_array().map(Vec::len), Some(0));
    // The panel is local content and does have a policy of Tauri's making.
    assert!(config["app"]["security"]["csp"].is_string());
}

/* ---- what this application is, to macOS -------------------------------- */

/// A Dock icon while there is a window, and none while there is not.
///
/// Not a preference: showing the capture panel has to make it the key window,
/// and `tao` does that with `activateIgnoringOtherApps:`, which activates the
/// application and brings its other windows over whatever was in front. In a
/// permanently `Regular` application, pressing the shortcut over somebody else's
/// window would pop the whole of ndBrain over it and putting the panel away
/// would leave them looking at ndBrain — which is the one promise the panel
/// exists to keep.
#[test]
fn claims_a_dock_icon_only_while_there_is_a_window_to_come_back_to() {
    assert_eq!(presence_for(true), Presence::Dock);
    assert_eq!(presence_for(false), Presence::MenuBarOnly);
}

/* ---- the window is in front when the application opens ------------------ */

/// The first show happens at `RunEvent::Ready`, not at the end of `setup`.
///
/// An activation asked for during `setup` arrives before macOS considers the
/// application started, and is dropped. The window then opens *behind* whatever
/// the person was working in, and only a click on the Dock icon brings it
/// forward — which looks like an application that did not start.
///
/// Nothing but launching the built bundle shows this. Under `cargo run` the
/// terminal is already the active application, so the window comes up in front
/// by accident and every test passes. It was found by installing the app and
/// opening it, and this is here so it is not quietly undone: reading the source
/// is a poor test, but the alternative is a running WebView and a window server.
#[test]
fn shows_the_window_once_the_application_is_ready() {
    let source = include_str!("../src/lib.rs");

    let setup_shows = source
        .split("RunEvent::Ready")
        .next()
        .expect("the source")
        .contains("show_main(&handle)");
    assert!(!setup_shows, "`show_main` is back in `setup`; the window will open behind other applications");

    assert!(
        source.contains("RunEvent::Ready => show_main(app)"),
        "nothing shows the window when the application becomes ready"
    );
}
