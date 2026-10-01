//! The menu-bar icon, which is not a small application icon.
//!
//! Two things went wrong with the first version of this, and they are different
//! mistakes that produced the same symptom — an icon the owner had to hunt for.
//!
//! **It was the app icon.** `app.default_window_icon()` is the 512-pixel mark
//! from `bundle.icon`, and the mark is drawn as a near-white outline on a
//! near-black ground (`web/scripts/icons.mjs`). macOS scaled it to 18 pt and
//! drew it as the picture it is: a dark tile, which disappears into a dark menu
//! bar and sits in a light one looking like a bruise. A menu-bar icon is a
//! **template** — shape in the alpha channel, nothing in the colour channels —
//! which macOS then fills with whatever contrasts, and inverts while the menu is
//! open. `icons.mjs` derives one from the same PNG, so there is still one copy
//! of the geometry.
//!
//! **And the absence was silent.** The old code read
//!
//! ```text
//! if let Some(icon) = app.default_window_icon().cloned() { tray = tray.icon(icon); }
//! tray.build(app)?;
//! ```
//!
//! so a missing icon built a tray with no icon at all and told nobody. This
//! project does that on purpose elsewhere — a refusal that looks like an absence
//! is a decision it has written down — but not here. The bytes are now
//! `include_bytes!`, which means the file cannot be missing at runtime: it is
//! missing at compile time or not at all.

use tauri::image::Image;

/// The icon's side, in pixels.
///
/// `tray-icon` draws whatever it is handed at 18 pt tall — its macOS backend
/// sets the `NSImage` size to 18 and lets the bitmap supply the detail
/// (`tray-icon-0.25.1/src/platform_impl/macos/mod.rs`). So the number that
/// matters is not the glyph's size but how many pixels back those 18 points:
/// 36 is 18 pt at 2x, which is every Mac this runs on.
pub const SIDE: u32 = 36;

/// Raw RGBA, written by `desktop/icons.mjs`.
///
/// Not a PNG, because decoding one would mean either Tauri's `image-png`
/// feature or a decoder of our own, and neither buys anything: `Image::new`
/// takes exactly these bytes and is a `const fn` over them.
const RGBA: &[u8] = include_bytes!("../icons/tray.rgba");

// A blob of the wrong length would otherwise reach `Icon::from_rgba` and come
// back as a runtime error on a path nobody watches. This is the same check, at
// the one moment where it can be answered by not building.
const _: () = assert!(RGBA.len() == (SIDE * SIDE * 4) as usize);

/// What the tray is given to draw.
///
/// A struct rather than two arguments at the call site, so the one property that
/// cannot be seen in a screenshot of the code — that this is a template — is
/// carried with the pixels instead of being a `true` somebody may drop.
pub struct Art {
    pub rgba: &'static [u8],
    pub side: u32,
    /// Whether macOS may tint this to suit the menu bar. Always true here; see
    /// the module header for what happens when it is not.
    pub template: bool,
}

impl Art {
    pub fn image(&self) -> Image<'static> {
        Image::new(self.rgba, self.side, self.side)
    }

    /// The alpha at one pixel. The colour channels are never read by anything.
    pub fn alpha(&self, x: u32, y: u32) -> u8 {
        self.rgba[((y * self.side + x) * 4 + 3) as usize]
    }
}

pub fn art() -> Art {
    Art { rgba: RGBA, side: SIDE, template: true }
}
