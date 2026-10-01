//! The menu-bar icon, which was invisible and said nothing about it.
//!
//! Two defects, one symptom. The icon handed to the tray was `bundle.icon` — the
//! 512-pixel application mark, a near-white outline on a near-black ground — and
//! it was handed over without `icon_as_template`, so macOS drew the picture as
//! it is: a dark tile in the menu bar. And the code read
//!
//! ```text
//! if let Some(icon) = app.default_window_icon().cloned() { tray = tray.icon(icon); }
//! ```
//!
//! which built a tray with no icon at all if there was none, and told nobody.
//!
//! What is checkable here is the icon itself, and these tests check the three
//! properties that failing produce exactly the reported symptom: that it is
//! declared a template, that its shape is in the alpha channel, and that the
//! shape is the mark rather than a block or nothing at all. The absence case is
//! gone by construction — the bytes are `include_bytes!` and their length is a
//! `const` assertion, so a missing or malformed icon is a build that does not
//! finish rather than a tray that is quietly empty.

use ndbrain_desktop::tray;

/// Without this macOS draws the bitmap's own colours into the menu bar, which is
/// how a near-black tile came to be the icon on a dark menu bar.
#[test]
fn is_declared_a_template_so_macos_tints_it() {
    assert!(tray::art().template);
}

/// 18 pt at 2x. `tray-icon` sets the `NSImage` size to 18 points whatever it is
/// given, so the pixel count is only ever about sharpness — and 512 was 28 times
/// more than the menu bar can show.
#[test]
fn is_sized_for_the_menu_bar_rather_than_the_dock() {
    assert_eq!(tray::art().side, 36);
    assert_eq!(tray::SIDE, 36);
}

/// A template carries nothing in its colour channels: macOS reads the alpha and
/// fills the shape itself. Anything in the colours is either ignored or, in the
/// one case that bit, drawn.
#[test]
fn carries_its_shape_in_the_alpha_channel_alone() {
    let art = tray::art();
    let coloured: Vec<usize> = art
        .rgba
        .chunks(4)
        .enumerate()
        .filter(|(_, pixel)| pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0)
        .map(|(at, _)| at)
        .collect();
    assert!(coloured.is_empty(), "{} pixels carry colour, starting at {:?}", coloured.len(), coloured.first());
}

/// The reported symptom, as an assertion: there is something to see.
///
/// An icon whose alpha is zero everywhere is the thing somebody went looking for
/// and could not find, and it is a perfectly valid image file.
#[test]
fn is_not_invisible() {
    let art = tray::art();
    let opaque = art.rgba.chunks(4).filter(|pixel| pixel[3] > 0).count();
    assert!(opaque > 0, "every pixel is transparent; there is no icon");
    assert!(art.rgba.chunks(4).any(|pixel| pixel[3] == 255), "nothing is fully opaque");
}

/// And it is the mark, not a filled square.
///
/// The mark is two brackets facing each other, so the glyph has a clear vertical
/// gap down its middle and mass on either side of it. A solid block would pass
/// every test above — it is a template, it has alpha, it is visible — and would
/// still be the wrong icon, drawn as a lozenge in the menu bar.
///
/// This used to describe a rounded frame with two bars, which is what the icon
/// script drew while the interface drew a brain. The two marks had drifted apart
/// and nothing compared them; they are one shape again, and this is the test that
/// noticed.
#[test]
fn draws_the_mark_rather_than_a_block() {
    let art = tray::art();
    let middle = art.side / 2;
    let solid = |x: u32, y: u32| art.alpha(x, y) > 200;

    // The fissure: empty down the whole middle, not just at the centre point.
    for y in [middle / 2, middle, middle + middle / 2] {
        assert_eq!(art.alpha(middle, y), 0, "the middle is filled at y={y}; this is a block, not the mark");
    }

    // And mass on both sides of it, top and bottom — the arms of the brackets.
    let left = art.side / 4;
    let right = art.side - art.side / 4;
    assert!(solid(left, 3), "no left bracket along the top");
    assert!(solid(right, 3), "no right bracket along the top");
    assert!(solid(left, art.side - 4), "no left bracket along the bottom");
    assert!(solid(right, art.side - 4), "no right bracket along the bottom");

    // The spines, which is what keeps the arms from being two separate dashes.
    assert!(solid(2, middle), "no spine down the left");
    assert!(solid(art.side - 3, middle), "no spine down the right");
}

/// The glyph reaches the edges of its own bitmap.
///
/// The application icon has a margin, because an icon in the Dock sits in a
/// tile. A menu-bar glyph that kept that margin would render as a mark too small
/// to read, in a bar that supplies its own spacing — which is the second half of
/// why the icon was hard to find.
#[test]
fn fills_its_bitmap_instead_of_keeping_the_dock_icons_margin() {
    let art = tray::art();
    let rows_with_ink = (0..art.side)
        .filter(|y| (0..art.side).any(|x| art.alpha(x, *y) > 0))
        .count() as u32;
    assert!(
        rows_with_ink >= art.side - 2,
        "the mark uses {rows_with_ink} of {} rows; it is carrying the app icon's margin",
        art.side
    );
}
