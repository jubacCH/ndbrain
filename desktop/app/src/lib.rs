//! ndBrain's Mac client: the application, and the shortcut that outlives it.
//!
//! **What changed, and why the old reasoning was right about the wrong
//! product.** This file used to open with an argument against loading
//! `https://ndbrain.b8n.ch` into a window at all: an installed PWA is already a
//! chromeless window with a Dock icon, so a WebView would add a second place to
//! be signed in, a second cache to go stale and a second content-security
//! policy to keep working, in exchange for nothing. Every one of those three is
//! real. What the argument got wrong is the "in exchange for nothing": the
//! product wanted here is an application somebody *uses their notes in*, not a
//! key combination that launches a browser. A browser tab is where the notes
//! live now; it should not be.
//!
//! So there is a window, and the three objections are answered rather than
//! waved away:
//!
//!  1. **Two places to be signed in.** The WebView's cookie store and the
//!     Keychain item the capture panel uses are genuinely separate. They are
//!     reconciled in both directions, by `share_the_session`: a sign-in in the
//!     window reaches the panel, and a sign-in in the panel reaches the window.
//!     Signing out clears both. One sign-in, wherever it happens.
//!  2. **A second cache.** A single-page app without a router never navigates,
//!     so a window left open runs the JavaScript it loaded straight through a
//!     deploy — `web/src/build.ts` says so, and a WebView that is never closed
//!     makes it the normal state rather than the exception. The entry module's
//!     content hash is compared against the one the server is serving whenever
//!     the window is focused, and only a confirmed difference reloads it; see
//!     `ndbrain_capture::freshness`.
//!  3. **A second content-security policy.** There is not one. Tauri's `csp`
//!     applies to what Tauri serves, which here is the capture panel alone; the
//!     main window is remote content and keeps the policy the server sends with
//!     it. `tests/main_window.rs` pins that the main window is also outside the
//!     IPC capability, so the served page cannot call into this process.
//!
//! **The menu-bar half stays**, because it is the half a WebView cannot do: a
//! key combination answered while another application has the keyboard. The
//! rule it is arranged around is unchanged — a thought leaves the panel only
//! once the server has written it down, and `reply_for` is the only place
//! `saved: true` is reachable from.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use ndbrain_capture::{
    base_url, freshness, CaptureError, LoginOutcome, Outcome, SESSION_COOKIE,
};
use ndbrain_client::{today, Client};
use serde::Serialize;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{Cookie, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub mod copy;
pub mod frame;
pub mod keychain;
pub mod settings;
pub mod tray;

use copy::COPY;
use frame::Frame;
use settings::Settings;

/// The capture panel's window label. One window, created hidden at startup and
/// shown by the shortcut: building it on demand would put a WebView boot between
/// the key and the cursor, and the whole promise is that it is there immediately.
const PANEL: &str = "capture";

/// The application's own window — ndBrain itself.
const MAIN: &str = "main";

/* ---- what the application is, to macOS ---------------------------------- */

/// How the application presents itself: in the Dock, or only in the menu bar.
///
/// Our own two-value enum rather than `tauri::ActivationPolicy` so the decision
/// can be tested without starting a WebView.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    /// A Dock icon, a place in ⌘-Tab, and an application menu.
    Dock,
    /// The menu bar only.
    MenuBarOnly,
}

/// Which presence belongs with a given state of the main window.
///
/// **This is the one design decision in here worth arguing about**, because the
/// brief said to leave `ActivationPolicy::Accessory` behind and this keeps it —
/// for exactly half the time.
///
/// The reason is a side effect of macOS, not a preference. Showing the capture
/// panel has to make it the key window, and `tao` does that with
/// `makeKeyAndOrderFront` followed by `activateIgnoringOtherApps:` — which
/// activates the *application*, bringing its other windows in front of whatever
/// was there. In a `Regular` application that means pressing ⌘⇧Space over
/// somebody else's window pops the whole of ndBrain over it, and putting the
/// panel away leaves them looking at ndBrain rather than at what they were
/// doing. That is the one promise the panel exists to keep.
///
/// So the application is `Regular` while it has a window to come back to, and
/// an accessory while it does not. The old comment here said a Dock icon for
/// something that is only ever a panel over somebody else's window is a lie
/// about what it is; that is still true, and it is now only true half the time.
///
/// What this costs: while the main window is open, the shortcut does raise it.
/// Accepted, because somebody with ndBrain open is not surprised to see ndBrain.
pub fn presence_for(main_window_visible: bool) -> Presence {
    if main_window_visible {
        Presence::Dock
    } else {
        Presence::MenuBarOnly
    }
}

#[cfg(target_os = "macos")]
fn apply(app: &AppHandle, presence: Presence) {
    let _ = app.set_activation_policy(match presence {
        Presence::Dock => tauri::ActivationPolicy::Regular,
        Presence::MenuBarOnly => tauri::ActivationPolicy::Accessory,
    });
}

#[cfg(not(target_os = "macos"))]
fn apply(_app: &AppHandle, _presence: Presence) {}

/// Re-reads the main window's visibility and tells macOS what this is.
fn settle_presence(app: &AppHandle) {
    let visible =
        app.get_webview_window(MAIN).and_then(|window| window.is_visible().ok()).unwrap_or(false);
    apply(app, presence_for(visible));
}

/* ---- what a close request means ----------------------------------------- */

/// What to do when a window is asked to close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closing {
    /// Hide it, remember where it was, and drop the Dock icon.
    PutItAway,
    /// Refuse, and leave it to the window itself.
    LeaveItToTheWindow,
}

/// Neither window is ever destroyed, but they refuse for different reasons.
///
/// The main window hides: there is nothing in it that is not on the server, and
/// the process has to stay alive for the shortcut either way.
///
/// **The panel refuses outright**, and that is the half worth writing down. The
/// panel is put away by `esc`, which it gates on whether the field is empty —
/// hiding a panel that still holds an unsent thought is the one outcome this
/// whole application exists to prevent. The panel has no close button and there
/// was no menu, so nothing could ask it to close; an application menu brings
/// `⌘W` with it, and `⌘W` knows nothing about unsent text. So it does nothing
/// here, exactly as it did when there was no menu to press it from.
pub fn closing(label: &str) -> Closing {
    if label == PANEL {
        Closing::LeaveItToTheWindow
    } else {
        Closing::PutItAway
    }
}

/* ---- state -------------------------------------------------------------- */

/// Everything the commands and the event handlers need.
///
/// Behind separate mutexes, because they are touched from different places: the
/// settings from a keystroke, the frame from a window drag, the bundle name from
/// a background request.
pub struct Shell {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    /// What was wrong with the settings file, if anything, so the panel can say it.
    complaint: Mutex<Option<String>>,
    frame_path: PathBuf,
    /// Where the main window is right now, kept in memory and written on the
    /// events that mean somebody has stopped moving it. Writing on every
    /// `Moved` would be a file write per frame of a drag.
    frame: Mutex<Option<Frame>>,
    /// The entry module the main window is running, as far as anyone knows.
    loaded_bundle: Mutex<Option<String>>,
    /// Whether the Keychain's session has already been offered to the WebView
    /// this run.
    ///
    /// Once, and once only. The injection is followed by a reload, so a cookie
    /// the WebView will not keep — a domain that does not match, a store that
    /// refuses it — would otherwise be offered again on the reload's page load,
    /// and the window would reload itself for as long as the application ran.
    session_offered: AtomicBool,
}

impl Shell {
    pub fn new(config_dir: PathBuf) -> Self {
        let path = settings::settings_path(&config_dir);
        let (settings, complaint) = Settings::read(&path);
        let frame_path = frame::frame_path(&config_dir);
        Self {
            settings: Mutex::new(settings),
            settings_path: path,
            complaint: Mutex::new(complaint),
            frame: Mutex::new(frame::read(&frame_path)),
            frame_path,
            loaded_bundle: Mutex::new(None),
            session_offered: AtomicBool::new(false),
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
    app: AppHandle,
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

    // The window gets the same session. This is the half of the answer to "two
    // places to be signed in" that runs in this direction: somebody who signed
    // in at the panel does not then meet a login screen in the window.
    hand_the_session_to_the_window(&app, &settings.address, &token);

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

/* ---- the session, shared between the window and the panel --------------- */

/// The session cookie as the server would have set it.
///
/// `secure` follows the address rather than being hard-coded, because
/// `base_url` admits `http://localhost` and a `Secure` cookie would not be sent
/// there — which would look exactly like the WebView ignoring the injection.
/// No expiry: a session cookie is kept for as long as the WebView's store lives,
/// and inventing a date the server did not give would either end the session
/// early or outlive it.
pub fn session_cookie(address: &str, token: &str) -> Option<Cookie<'static>> {
    let base = base_url(address).ok()?;
    let url = Url::parse(&base).ok()?;
    let host = url.host_str()?.to_string();
    Some(
        Cookie::build((SESSION_COOKIE, token.to_string()))
            .domain(host)
            .path("/")
            .http_only(true)
            .secure(url.scheme() == "https")
            .build(),
    )
}

/// Puts a session into the main window's cookie store and loads the page again.
///
/// `set_cookie` and `reload` both travel the same channel to the event loop and
/// are handled in order, and the `set_cookie` handler blocks until WebKit has
/// confirmed the write — so the reload cannot race ahead of the cookie.
fn hand_the_session_to_the_window(app: &AppHandle, address: &str, token: &str) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let Some(cookie) = session_cookie(address, token) else { return };
    if window.set_cookie(cookie).is_ok() {
        let _ = window.reload();
    }
}

/// Makes the window's session and the panel's session one session.
///
/// Both directions, because a sign-in can happen in either place:
///
///  - the WebView has one and the Keychain does not, or has an older one: the
///    person signed in at the window, and the panel is told. This is the common
///    case and the one that matters — the window is where a password gets typed
///    now.
///  - the Keychain has one and the WebView does not: the panel signed in, or a
///    previous run did and this is a fresh WebView store. The cookie is handed
///    over and the page loaded again, **once per run** — see `session_offered`.
///
/// Must not run on the main thread: reading cookies sends a message to the event
/// loop and waits for the answer, which on the main thread is a deadlock.
fn share_the_session(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let settings = shell.snapshot();
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let Ok(base) = base_url(&settings.address) else { return };
    let Ok(url) = Url::parse(&base) else { return };

    let in_webview = window
        .cookies_for_url(url)
        .ok()
        .into_iter()
        .flatten()
        .find(|cookie| cookie.name() == SESSION_COOKIE)
        .map(|cookie| cookie.value().to_string())
        .filter(|value| !value.is_empty());

    let in_keychain = keychain::session(&settings.account);

    match (in_webview, in_keychain) {
        (Some(from_window), held) if Some(&from_window) != held.as_ref() => {
            // The account is whatever the settings say, which is what the
            // Keychain is keyed on. A sign-in in the window under a different
            // name is a case this cannot see — the cookie does not carry one —
            // and the panel's own sign-in is what fixes it.
            let _ = keychain::remember(&settings.account, &from_window);
        }
        (None, Some(held)) if !shell.session_offered.swap(true, Ordering::SeqCst) => {
            hand_the_session_to_the_window(app, &settings.address, &held);
        }
        _ => {}
    }
}

/// Signs out of both halves at once.
///
/// Forgetting the Keychain item alone would leave the window signed in, which is
/// worse than not offering the menu item: "Sign out" that signs out of one of
/// two places is a false statement about the state of the machine.
fn sign_out(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let settings = shell.snapshot();
    keychain::forget(&settings.account);

    if let Some(window) = app.get_webview_window(MAIN) {
        if let Some(cookie) = session_cookie(&settings.address, "") {
            let _ = window.delete_cookie(cookie);
            let _ = window.reload();
        }
    }
    // So the next page load may offer a session that has been signed in again.
    shell.session_offered.store(false, Ordering::SeqCst);
}

/* ---- is the window running what the server is serving? ------------------ */

/// Asks the server which build it is serving, and reloads if it is not this one.
///
/// Must not run on the main thread: it makes a request.
async fn check_for_a_newer_build(app: AppHandle) {
    let settings = app.state::<Shell>().snapshot();
    let Ok(client) = Client::new(&settings.address) else { return };
    let served = client.served_bundle().await;

    let shell = app.state::<Shell>();
    let loaded = shell.loaded_bundle.lock().expect("bundle lock").clone();

    if !freshness(loaded.as_deref(), served.as_deref()).asks_for_a_reload() {
        return;
    }

    // Written down *before* the reload, so the page load that follows compares
    // against the new name and this cannot fire twice for one deploy.
    *shell.loaded_bundle.lock().expect("bundle lock") = served;
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.reload();
    }
}

/// Records which build the window has just loaded.
async fn remember_the_loaded_build(app: AppHandle) {
    let settings = app.state::<Shell>().snapshot();
    let Ok(client) = Client::new(&settings.address) else { return };
    let served = client.served_bundle().await;
    // Only ever replaced by something that could be read: a failed fetch here
    // would otherwise erase the name and make the next comparison `Unknown`.
    if served.is_some() {
        *app.state::<Shell>().loaded_bundle.lock().expect("bundle lock") = served;
    }
}

/* ---- the windows -------------------------------------------------------- */

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

/// Brings ndBrain itself to the front.
fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    // The Dock icon before the window, so macOS has somewhere to put it.
    apply(app, Presence::Dock);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Where the window is now, if it is in a state worth recording.
///
/// A minimised window reports a position macOS uses for the animation rather
/// than one anybody chose, and storing it would restore the window somewhere
/// nobody put it.
fn current_frame(window: &WebviewWindow) -> Option<Frame> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Frame { x: position.x, y: position.y, width: size.width, height: size.height })
}

/// Keeps the latest frame in memory. Called on every move and resize.
fn note_frame(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    if let Some(frame) = current_frame(&window) {
        *app.state::<Shell>().frame.lock().expect("frame lock") = Some(frame);
    }
}

/// Writes the frame down. Called when somebody has stopped moving the window.
fn save_frame(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let frame = *shell.frame.lock().expect("frame lock");
    if let Some(frame) = frame {
        let _ = frame::write(&shell.frame_path, &frame);
    }
}

/// The displays as they are attached right now, in the frame's own coordinates.
fn screens(window: &WebviewWindow) -> Vec<Frame> {
    window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| Frame {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect()
}

/// Opens the main window where it was, or centred if that is not somewhere it
/// can be used.
///
/// Built hidden and shown at the end, so a frame being restored is not a window
/// jumping from the middle of the screen to where it belongs.
fn build_main_window(app: &AppHandle, address: &str) -> tauri::Result<()> {
    // A bad address is not a reason to have no window: the page will fail to
    // load and say so in the WebView, which is more use than no window at all.
    let url = base_url(address)
        .ok()
        .and_then(|base| Url::parse(&base).ok())
        .unwrap_or_else(|| Url::parse(settings::DEFAULT_ADDRESS).expect("the default address"));

    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title(copy::MENU_APP)
        .inner_size(frame::DEFAULT_WIDTH, frame::DEFAULT_HEIGHT)
        .min_inner_size(frame::MIN_WIDTH, frame::MIN_HEIGHT)
        .visible(false)
        .center()
        // Dropped files would otherwise be swallowed by Tauri's own handler and
        // never reach the page, where ndBrain's upload lives.
        .disable_drag_drop_handler()
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let app = window.app_handle().clone();
            // Off the main thread: both of these block on the event loop.
            tauri::async_runtime::spawn(async move {
                let handle = app.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || share_the_session(&handle))
                    .await;
                remember_the_loaded_build(app).await;
            });
        })
        .build()?;

    let stored = *app.state::<Shell>().frame.lock().expect("frame lock");
    let restored = stored.and_then(|frame| frame.worth_restoring(&screens(&window)));

    if let Some(frame) = restored {
        let _ = window.set_size(tauri::PhysicalSize::new(frame.width, frame.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(frame.x, frame.y));
    } else {
        // Nothing worth restoring: forget it rather than keep writing it back.
        *app.state::<Shell>().frame.lock().expect("frame lock") = None;
    }

    Ok(())
}

/* ---- the application menu ----------------------------------------------- */

/// The menu along the top of the screen.
///
/// `PredefinedMenuItem` with `None` for the text everywhere it will do: those
/// labels come from `muda`'s own English table, and a label this project does
/// not write is one it cannot get wrong. The two items with text of their own
/// are in `copy.rs` with everything else this application says.
///
/// **Quit is a menu item of ours, not `PredefinedMenuItem::quit`.** The
/// predefined one is wired to `terminate:`, which takes the application down
/// past the `ExitRequested` handler at the bottom of this file — the handler
/// whose whole job is to keep the process alive when a window closes. Ours
/// calls `app.exit(0)`, which goes through it with a code, and a code is what
/// that handler lets through.
fn application_menu(app: &AppHandle, quit: &MenuItem<tauri::Wry>) -> tauri::Result<Menu<tauri::Wry>> {
    let reload = MenuItem::with_id(
        app,
        "reload",
        copy::MENU_RELOAD,
        true,
        Some("CmdOrCtrl+R"),
    )?;

    let about = PredefinedMenuItem::about(app, None, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let rule_one = PredefinedMenuItem::separator(app)?;
    let rule_two = PredefinedMenuItem::separator(app)?;
    // Spelled out as `&dyn IsMenuItem`, which the signature asks for: an array
    // mixing a `MenuItem` with a `PredefinedMenuItem` has no common element type.
    let app_items: [&dyn IsMenuItem<tauri::Wry>; 7] =
        [&about, &rule_one, &hide, &hide_others, &show_all, &rule_two, quit];
    let application = Submenu::with_items(app, copy::MENU_APP, true, &app_items)?;

    // Without these there is no ⌘C and no ⌘V anywhere in the application: in a
    // Mac application those keystrokes are menu accelerators, and a WebView
    // does not supply its own.
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let rule_three = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy_item = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_items: [&dyn IsMenuItem<tauri::Wry>; 7] =
        [&undo, &redo, &rule_three, &cut, &copy_item, &paste, &select_all];
    let edit = Submenu::with_items(app, copy::MENU_EDIT, true, &edit_items)?;

    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let view_items: [&dyn IsMenuItem<tauri::Wry>; 2] = [&reload, &fullscreen];
    let view = Submenu::with_items(app, copy::MENU_VIEW, true, &view_items)?;

    let minimise = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, None)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let rule_four = PredefinedMenuItem::separator(app)?;
    let front = PredefinedMenuItem::bring_all_to_front(app, None)?;
    let window_items: [&dyn IsMenuItem<tauri::Wry>; 5] =
        [&minimise, &zoom, &close, &rule_four, &front];
    let window_menu = Submenu::with_items(app, copy::MENU_WINDOW, true, &window_items)?;

    Menu::with_items(app, &[&application, &edit, &view, &window_menu])
}

/* ---- the shell ---------------------------------------------------------- */

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ready, capture, sign_in, dismiss])
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let shell = Shell::new(config_dir);
            let settings = shell.snapshot();
            app.manage(shell);

            let handle = app.handle().clone();
            build_main_window(&handle, &settings.address)?;

            // Hidden, decorationless, over everything, and never destroyed: the
            // field keeps whatever is in it between showings, so a thought the
            // server refused is still there when the panel comes back.
            WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("capture.html".into()))
                .title(copy::MENU_APP)
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

            // The shortcut is half the product. If the combination is already
            // taken, the registration fails and nothing would otherwise say so —
            // somebody would be left with a menu-bar icon and no explanation. So
            // it is named in the menu, where it cannot be missed.
            let capture_label = if registered {
                copy::shortcut_ready(&combination)
            } else {
                copy::shortcut_taken(&combination)
            };

            let quit_item = MenuItem::with_id(
                app,
                "quit",
                copy::MENU_QUIT,
                true,
                Some("CmdOrCtrl+Q"),
            )?;
            app.set_menu(application_menu(&handle, &quit_item)?)?;

            let capture_item = MenuItem::with_id(app, "capture", capture_label, true, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", copy::MENU_OPEN, true, None::<&str>)?;
            let sign_out_item =
                MenuItem::with_id(app, "sign-out", copy::MENU_SIGN_OUT, true, None::<&str>)?;
            // Spelled out as `&dyn IsMenuItem`, which the signature asks for:
            // a bare array of two different item types has no common element type.
            let first_rule = PredefinedMenuItem::separator(app)?;
            let second_rule = PredefinedMenuItem::separator(app)?;
            let items: [&dyn IsMenuItem<tauri::Wry>; 6] = [
                &open_item,
                &capture_item,
                &first_rule,
                &sign_out_item,
                &second_rule,
                &quit_item,
            ];
            let menu = Menu::with_items(app, &items)?;

            // The icon is `include_bytes!`, so there is no case where it is
            // absent and a tray gets built without one — which is what happened
            // before, silently. `icon_as_template` is what makes macOS tint the
            // glyph for the menu bar instead of drawing a dark tile into it.
            let art = tray::art();
            TrayIconBuilder::with_id("ndbrain")
                .icon(art.image())
                .icon_as_template(art.template)
                .menu(&menu)
                .tooltip(copy::TOOLTIP)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "capture" => show_panel(app),
                    "open" => show_main(app),
                    "sign-out" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn_blocking(move || sign_out(&handle));
                        // Said, not left to be inferred from the next capture
                        // asking for a password.
                        show_panel(app);
                        if let Some(window) = app.get_webview_window(PANEL) {
                            let _ = window.emit("signed-out", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "reload" => {
                if let Some(window) = app.get_webview_window(MAIN) {
                    let _ = window.reload();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_window_event(|window, event| {
            let app = window.app_handle().clone();
            let is_main = window.label() == MAIN;
            match event {
                // Hidden, not closed. Closing the window would end the process
                // and take the shortcut with it, and the shortcut is the half of
                // this that has to outlive the window.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if closing(window.label()) == Closing::PutItAway {
                        let _ = window.hide();
                        save_frame(&app);
                        // No window to come back to, so no Dock icon claiming
                        // there is one — and the panel goes back to appearing
                        // over other applications without raising ndBrain.
                        settle_presence(&app);
                    }
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) if is_main => {
                    note_frame(&app);
                }
                tauri::WindowEvent::Focused(focused) if is_main => {
                    if *focused {
                        // The moment somebody comes back to the window is the
                        // cheapest moment to replace it, so it is the moment the
                        // build is checked. Only a confirmed difference reloads;
                        // see `ndbrain_capture::freshness`.
                        tauri::async_runtime::spawn(check_for_a_newer_build(app.clone()));
                    } else {
                        // Losing focus is the end of a drag often enough to be
                        // the one place a frame is reliably worth writing.
                        save_frame(&app);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("ndBrain could not start")
        .run(|app, event| match event {
            // Without this, hiding the last window on macOS is treated as having
            // no reason to stay running. The whole point is to stay running.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => save_frame(app),
            // First light. The window is shown here rather than at the end of
            // `setup`, because an activation asked for there arrives before
            // macOS considers the application started and is simply dropped:
            // the window opened behind whatever the person was working in, and
            // only a click on the Dock icon brought it forward. Nothing but
            // launching the built application shows this — in `cargo run` the
            // terminal is already the active application, so the window came up
            // in front by accident.
            tauri::RunEvent::Ready => show_main(app),
            // The Dock icon, clicked. A `Regular` application that answered
            // nothing here would bounce its icon and show nothing.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
