//! ndBrain's Mac client: a menu-bar app whose reason to exist is one shortcut.
//!
//! **What this deliberately is not.** It does not load `https://ndbrain.b8n.ch`
//! into a window. The README says ndBrain "installs to a home screen or a taskbar
//! from the browser", and an installed PWA on macOS is already a chromeless
//! window with its own Dock icon — so a WebView here would add a second place to
//! be signed in, a second cache to go stale and a second content-security policy
//! to keep working, in exchange for nothing. The menu opens the real app in the
//! default browser, and there stays one copy of it.
//!
//! What it does add is the thing a browser cannot: a key combination that works
//! while another application has the keyboard. A thought reaches today's note
//! without leaving the window it arrived in.
//!
//! **The rule the whole thing is arranged around:** a thought leaves the panel
//! only once the server has written it down. `Outcome::Saved` is the one answer
//! that clears the field; offline, expired, refused and unanswered all leave the
//! text exactly where it is, with a line saying why. There is no outbox and no
//! draft on disk, because "server-centred, no local copies" is the decision this
//! project hangs on and a capture queue would be a sync protocol with one entry.

use std::path::PathBuf;
use std::sync::Mutex;

use ndbrain_capture::{CaptureError, LoginOutcome, Outcome};
use ndbrain_client::{today, Client};
use serde::Serialize;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub mod copy;
pub mod keychain;
pub mod settings;

use copy::COPY;
use settings::Settings;

/// The panel's window label. One window, created hidden at startup and shown by
/// the shortcut: building it on demand would put a WebView boot between the key
/// and the cursor, and the whole promise is that it is there immediately.
const PANEL: &str = "capture";

/// Everything the commands need. Behind one mutex, because every path through it
/// is a person pressing a key — there is nothing to contend over.
pub struct Shell {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    /// What was wrong with the settings file, if anything, so the panel can say it.
    complaint: Mutex<Option<String>>,
}

impl Shell {
    pub fn new(config_dir: PathBuf) -> Self {
        let path = settings::settings_path(&config_dir);
        let (settings, complaint) = Settings::read(&path);
        Self {
            settings: Mutex::new(settings),
            settings_path: path,
            complaint: Mutex::new(complaint),
        }
    }

    fn snapshot(&self) -> Settings {
        self.settings.lock().expect("settings lock").clone()
    }
}

/* ---- what the panel is told --------------------------------------------- */

#[derive(Debug, Serialize)]
pub struct Ready {
    copy: copy::Copy,
    /// Whether there is a session to capture with. False means the panel shows
    /// the sign-in fields under the field rather than instead of it, so a thought
    /// already typed is still there afterwards.
    signed_in: bool,
    account: String,
    address: String,
    /// A settings file that could not be read, named rather than swallowed.
    problem: Option<String>,
}

/// The answer to a capture attempt.
///
/// `saved` is the only field the panel may clear its text on, and it is set in
/// exactly one place below.
#[derive(Debug, Serialize)]
pub struct Reply {
    pub saved: bool,
    pub needs_sign_in: bool,
    pub message: String,
}

impl Reply {
    fn failed(message: impl Into<String>) -> Self {
        Self { saved: false, needs_sign_in: false, message: message.into() }
    }

    fn sign_in(message: impl Into<String>) -> Self {
        Self { saved: false, needs_sign_in: true, message: message.into() }
    }
}

/// Turns an answer from the server into what the panel does next.
///
/// The one function that may produce `saved: true`, and only from `Outcome::Saved`.
///
/// Public so a test can hold it to that. It is the chokepoint of the whole
/// promise: every path from the network runs through here, and a `saved: true`
/// reached from anything but a written note is a thought thrown away.
pub fn reply_for(outcome: Outcome) -> Reply {
    match outcome {
        Outcome::Saved { path, created } => {
            Reply { saved: true, needs_sign_in: false, message: copy::saved_in(&path, created) }
        }
        Outcome::SignInNeeded => Reply::sign_in(COPY.sign_in_title),
        Outcome::SlowDown { seconds } => Reply::failed(copy::slow_down(seconds)),
        Outcome::Failed { message } => Reply::failed(message),
    }
}

/* ---- commands ----------------------------------------------------------- */

#[tauri::command]
fn ready(shell: tauri::State<'_, Shell>) -> Ready {
    let settings = shell.snapshot();
    Ready {
        copy: COPY,
        signed_in: keychain::session(&settings.account).is_some(),
        account: settings.account.clone(),
        address: settings.address.clone(),
        problem: shell.complaint.lock().expect("complaint lock").clone(),
    }
}

#[tauri::command]
async fn capture(shell: tauri::State<'_, Shell>, text: String) -> Result<Reply, ()> {
    let settings = shell.snapshot();

    let Some(token) = keychain::session(&settings.account) else {
        return Ok(Reply::sign_in(COPY.sign_in_title));
    };

    let client = match Client::new(&settings.address) {
        Ok(client) => client,
        Err(error) => return Ok(Reply::failed(error.message())),
    };

    // `today` is read here rather than when the panel opened: a panel left
    // standing across midnight captures into the day it is actually sent in.
    match client.capture(&token, &text, &today()).await {
        Ok(outcome) => Ok(reply_for(outcome)),
        Err(CaptureError::Empty) => Ok(Reply::failed(CaptureError::Empty.message())),
    }
}

/// Signs in, and sends the thought that was waiting in the same breath.
///
/// One command rather than two, because the thought is the reason somebody is
/// looking at a password field at all. Signing in and then having to press ⌘↵
/// again is one more chance to lose it.
#[tauri::command]
async fn sign_in(
    shell: tauri::State<'_, Shell>,
    account: String,
    password: String,
    text: String,
) -> Result<Reply, ()> {
    let settings = shell.snapshot();

    let client = match Client::new(&settings.address) {
        Ok(client) => client,
        Err(error) => return Ok(Reply::failed(error.message())),
    };

    let token = match client.login(&account, &password).await {
        LoginOutcome::Signed { token } => token,
        LoginOutcome::WrongCredentials => return Ok(Reply::sign_in(COPY.wrong_credentials)),
        LoginOutcome::NoCookie => return Ok(Reply::sign_in(COPY.no_cookie)),
        LoginOutcome::SlowDown { seconds } => return Ok(Reply::sign_in(copy::slow_down(seconds))),
        LoginOutcome::Failed { message } => return Ok(Reply::sign_in(message)),
    };

    let account = account.trim().to_string();
    if let Err(error) = keychain::remember(&account, &token) {
        // The session is real but could not be kept. Said out loud: the
        // alternative is a client that asks for a password at every capture and
        // never explains why.
        return Ok(Reply::failed(error));
    }

    // Remembered so the next launch knows which Keychain item to look for.
    {
        let mut held = shell.settings.lock().expect("settings lock");
        held.account = account.clone();
        let _ = held.write(&shell.settings_path);
    }

    if text.trim().is_empty() {
        return Ok(Reply { saved: false, needs_sign_in: false, message: String::new() });
    }

    match client.capture(&token, &text, &today()).await {
        Ok(outcome) => Ok(reply_for(outcome)),
        Err(CaptureError::Empty) => Ok(Reply::failed(CaptureError::Empty.message())),
    }
}

/// Puts the panel away. Called only when the panel has nothing unsent in it —
/// the refusal to hide over an unsent thought is the panel's own, because it is
/// the half that knows whether the field is empty.
#[tauri::command]
fn dismiss(window: tauri::Window) {
    let _ = window.hide();
}

/* ---- the shell ---------------------------------------------------------- */

/// Brings the panel up over whatever is in front and puts the cursor in it.
fn show_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL) {
        let _ = window.show();
        // Both, and in this order: an accessory application is not frontmost, so
        // the window has to be made key as well as visible or the first
        // keystroke goes to whatever was in front.
        let _ = window.set_focus();
        let _ = window.emit("panel-shown", ());
    }
}

/// Hands the address to macOS's own launcher.
///
/// Through `base_url` first, and not only for tidiness: the string comes out of a
/// file somebody can edit, and `open` reads a leading `-` as a flag of its own.
/// Checking it means the argument is known to begin with a scheme. No plugin for
/// this — it is one process spawn.
fn open_in_browser(address: &str) {
    let Ok(checked) = ndbrain_capture::base_url(address) else { return };
    let _ = std::process::Command::new("/usr/bin/open").arg(checked).spawn();
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ready, capture, sign_in, dismiss])
        .setup(|app| {
            // No Dock icon and no application menu: there is no window to come
            // back to, and a Dock icon for something that is only ever a panel
            // over somebody else's window is a lie about what this is.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            let shell = Shell::new(config_dir);
            let settings = shell.snapshot();
            app.manage(shell);

            // Hidden, decorationless, over everything, and never destroyed: the
            // field keeps whatever is in it between showings, so a thought the
            // server refused is still there when the panel comes back.
            WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("capture.html".into()))
                .title("ndBrain")
                .inner_size(560.0, 220.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .center()
                .build()?;

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        // Pressed only. Acting on the release as well would show
                        // the panel and then show it again.
                        if event.state == ShortcutState::Pressed {
                            show_panel(app);
                        }
                    })
                    .build(),
            )?;

            let combination = settings.shortcut.clone();
            let registered = app.global_shortcut().register(combination.as_str()).is_ok();

            // The shortcut is the whole product. If the combination is already
            // taken, the registration fails and nothing would otherwise say so —
            // somebody would be left with a menu-bar icon and no explanation. So
            // it is named in the menu, where it cannot be missed.
            let capture_label = if registered {
                copy::shortcut_ready(&combination)
            } else {
                copy::shortcut_taken(&combination)
            };

            let capture_item = MenuItem::with_id(app, "capture", capture_label, true, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", copy::MENU_OPEN, true, None::<&str>)?;
            let sign_out_item =
                MenuItem::with_id(app, "sign-out", copy::MENU_SIGN_OUT, true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", copy::MENU_QUIT, true, None::<&str>)?;
            // Spelled out as `&dyn IsMenuItem`, which the signature asks for:
            // a bare array of two different item types has no common element type.
            let first_rule = PredefinedMenuItem::separator(app)?;
            let second_rule = PredefinedMenuItem::separator(app)?;
            let items: [&dyn IsMenuItem<tauri::Wry>; 6] = [
                &capture_item,
                &open_item,
                &first_rule,
                &sign_out_item,
                &second_rule,
                &quit_item,
            ];
            let menu = Menu::with_items(app, &items)?;

            let mut tray = TrayIconBuilder::with_id("ndbrain")
                .menu(&menu)
                .tooltip(copy::TOOLTIP)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "capture" => show_panel(app),
                    "open" => {
                        let address = app.state::<Shell>().snapshot().address;
                        open_in_browser(&address);
                    }
                    "sign-out" => {
                        let account = app.state::<Shell>().snapshot().account;
                        keychain::forget(&account);
                        // Said, not left to be inferred from the next capture
                        // asking for a password. The panel is the only surface
                        // this app has to say it on.
                        show_panel(app);
                        if let Some(window) = app.get_webview_window(PANEL) {
                            let _ = window.emit("signed-out", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hidden, not closed. Closing the only window would end the process,
            // and rebuilding the WebView on the next shortcut would put a boot
            // between the key and the cursor.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("ndBrain could not start")
        .run(|_app, event| {
            // Without this, hiding the last window on macOS is treated as having
            // no reason to stay running. The whole point is to stay running.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
