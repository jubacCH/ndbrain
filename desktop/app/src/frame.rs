//! Where the main window was, so it is there again next time.
//!
//! In its own file beside `settings.json` rather than inside it. `settings.json`
//! is three values somebody edits by hand; this is state the application writes
//! behind their back several times a session, and mixing the two would mean
//! rewriting a hand-edited file every time a window is dragged.
//!
//! **The failure worth guarding against is not a lost size, it is a window
//! nobody can reach.** A frame restored onto a display that is no longer
//! attached is off-screen, and an application whose window opens where there is
//! no screen looks exactly like an application that did not start. So a stored
//! frame is checked against the displays that exist now, and anything that does
//! not land on one is discarded in favour of a centred default.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The window the app opens with when there is nothing stored.
///
/// Wide enough for ndBrain's sidebar, a note and the inspector beside each
/// other, which is the layout the interface is built around.
pub const DEFAULT_WIDTH: f64 = 1180.0;
pub const DEFAULT_HEIGHT: f64 = 820.0;

/// The smallest window the interface is usable in, and the floor a stored frame
/// is held to.
pub const MIN_WIDTH: f64 = 520.0;
pub const MIN_HEIGHT: f64 = 420.0;

/// How much of the window has to be on a screen for it to count as reachable.
///
/// A strip of title bar, roughly: enough to put a pointer on and drag the rest
/// back into view. Smaller than this and the window is there in principle and
/// gone in practice.
const GRAB_WIDTH: i64 = 120;
const GRAB_HEIGHT: i64 = 28;

/// A window's outer rectangle, in physical pixels, as macOS reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Frame {
    fn right(&self) -> i64 {
        self.x as i64 + self.width as i64
    }

    fn bottom(&self) -> i64 {
        self.y as i64 + self.height as i64
    }

    /// How much of this frame lies inside another, as a width and a height.
    fn overlap(&self, other: &Frame) -> (i64, i64) {
        let width = self.right().min(other.right()) - (self.x as i64).max(other.x as i64);
        let height = self.bottom().min(other.bottom()) - (self.y as i64).max(other.y as i64);
        (width.max(0), height.max(0))
    }

    /// Whether a frame is big enough to work in.
    ///
    /// A zero or near-zero size is what a minimised or still-opening window can
    /// report, and storing one would mean next launch opens a sliver.
    pub fn is_big_enough(&self) -> bool {
        f64::from(self.width) >= MIN_WIDTH && f64::from(self.height) >= MIN_HEIGHT
    }

    /// Whether enough of this frame lands on one of the screens to be grabbed.
    ///
    /// `screens` is the displays as they are *now*, which is the whole point:
    /// the frame was written when a different set of them was attached.
    pub fn is_reachable(&self, screens: &[Frame]) -> bool {
        screens.iter().any(|screen| {
            let (width, height) = self.overlap(screen);
            width >= GRAB_WIDTH && height >= GRAB_HEIGHT
        })
    }

    /// The frame to actually open with, or `None` to let the window centre
    /// itself at the default size.
    ///
    /// One function rather than two checks at the call site, because the two
    /// have to be asked together: a frame that passes either one alone is still
    /// a window somebody cannot use.
    pub fn worth_restoring(self, screens: &[Frame]) -> Option<Self> {
        if self.is_big_enough() && self.is_reachable(screens) {
            Some(self)
        } else {
            None
        }
    }
}

/// `~/Library/Application Support/ch.b8n.ndbrain/window.json`.
pub fn frame_path(config_dir: &Path) -> PathBuf {
    config_dir.join("window.json")
}

/// The stored frame, or nothing.
///
/// Every failure is `None`, and that is the right answer for all of them: there
/// is no first run to distinguish from a corrupt file here, because a window
/// that cannot be restored is simply a window that opens centred. Nothing is
/// reported to anybody, which is the difference from `settings.json` — a
/// settings file that could not be read changes what the app *does*, and this
/// one only changes where it is.
pub fn read(path: &Path) -> Option<Frame> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

pub fn write(path: &Path, frame: &Frame) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(frame).unwrap_or_default()))
}
