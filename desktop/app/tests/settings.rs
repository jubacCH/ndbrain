//! The settings file: what it may be missing, and what it may not break.
//!
//! The property worth pinning is that **nothing about this file stops the app
//! from being there**. Its whole job is to be running when a thought arrives, and
//! a JSON typo is not a reason to be absent — but it is a reason to say something,
//! which is why a complaint comes back rather than being swallowed.

use std::path::PathBuf;

use ndbrain_desktop::settings::{Settings, DEFAULT_ADDRESS, DEFAULT_SHORTCUT};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ndbrain-desktop-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("settings.json")
}

#[test]
fn starts_on_the_defaults_when_there_is_no_file() {
    let (settings, complaint) = Settings::read(&scratch("absent"));

    assert_eq!(settings.address, DEFAULT_ADDRESS);
    assert_eq!(settings.shortcut, DEFAULT_SHORTCUT);
    assert_eq!(settings.account, "");
    // A first run is not a problem and must not be reported as one.
    assert_eq!(complaint, None);
}

/// The address the client is pointed at by default is the published one.
///
/// `CT 132 — ndBrain`: the internal `http://10.10.30.98:3000` stopped being usable
/// for signing in when `NDBRAIN_COOKIE_SECURE=true` was set, and a native client
/// pointed there would send the session token in clear text instead. So the
/// default is the HTTPS address, and the rest is `base_url`'s business.
#[test]
fn defaults_to_the_published_https_address() {
    assert!(DEFAULT_ADDRESS.starts_with("https://"), "{DEFAULT_ADDRESS}");
    assert!(ndbrain_capture::base_url(DEFAULT_ADDRESS).is_ok());
}

#[test]
fn fills_in_what_a_partial_file_leaves_out() {
    let path = scratch("partial");
    std::fs::write(&path, r#"{"account":"julian"}"#).unwrap();

    let (settings, complaint) = Settings::read(&path);

    assert_eq!(settings.account, "julian");
    assert_eq!(settings.address, DEFAULT_ADDRESS);
    assert_eq!(settings.shortcut, DEFAULT_SHORTCUT);
    assert_eq!(complaint, None);
}

/// A broken file is still a running app — and a complaint somebody can read.
#[test]
fn keeps_running_on_a_file_it_cannot_read_and_says_so() {
    let path = scratch("broken");
    std::fs::write(&path, "{ this is not json").unwrap();

    let (settings, complaint) = Settings::read(&path);

    assert_eq!(settings.address, DEFAULT_ADDRESS);
    assert!(complaint.is_some(), "a file that could not be read has to be reported");
}

#[test]
fn reads_back_what_it_wrote() {
    let path = scratch("roundtrip");
    let written = Settings {
        address: "https://example.test".into(),
        shortcut: "CommandOrControl+Shift+K".into(),
        account: "julian".into(),
    };
    written.write(&path).unwrap();

    let (read, complaint) = Settings::read(&path);
    assert_eq!(read, written);
    assert_eq!(complaint, None);
}

/// No secret in this file, ever. The session token is in the Keychain.
#[test]
fn holds_no_credential() {
    let source = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/settings.rs"),
    )
    .unwrap();

    let body = source.split_once("pub struct Settings {").unwrap().1.split_once('}').unwrap().0;
    for forbidden in ["password", "token", "secret", "key:"] {
        assert!(
            !body.to_lowercase().contains(forbidden),
            "Settings grew a field named like a credential ({forbidden}); it belongs in keychain.rs"
        );
    }
}
