//! The main window's size and position, across a restart.
//!
//! The easy half is writing four numbers to a file. The half worth testing is
//! refusing to use them: a frame stored while a second display was attached puts
//! the window off-screen when it is not, and an application whose window opens
//! where there is no screen is indistinguishable from one that did not start.

use std::path::PathBuf;

use ndbrain_desktop::frame::{self, Frame, MIN_HEIGHT, MIN_WIDTH};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ndbrain-frame-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("window.json")
}

/// A single built-in display, as a MacBook reports it.
fn laptop() -> Frame {
    Frame { x: 0, y: 0, width: 2560, height: 1600 }
}

/// A second display to the left, which is where negative coordinates come from.
fn second_display() -> Frame {
    Frame { x: -2560, y: 0, width: 2560, height: 1440 }
}

#[test]
fn reads_back_what_it_wrote() {
    let path = scratch("roundtrip");
    let written = Frame { x: 120, y: 80, width: 1400, height: 900 };
    frame::write(&path, &written).unwrap();

    assert_eq!(frame::read(&path), Some(written));
}

/// No file is the ordinary first run, and it is not reported as anything.
///
/// The difference from `settings.json`, which does complain: a settings file
/// that cannot be read changes what the application *does*, and this one only
/// changes where it is.
#[test]
fn has_nothing_to_say_about_a_file_that_is_not_there() {
    assert_eq!(frame::read(&scratch("absent")), None);
}

#[test]
fn ignores_a_file_it_cannot_read() {
    let path = scratch("broken");
    std::fs::write(&path, "{ not json at all").unwrap();

    assert_eq!(frame::read(&path), None);
}

#[test]
fn restores_a_frame_that_is_on_the_screen() {
    let frame = Frame { x: 200, y: 100, width: 1400, height: 900 };

    assert_eq!(frame.worth_restoring(&[laptop()]), Some(frame));
}

/// The case this exists for: the window was on a display that is gone.
#[test]
fn refuses_a_frame_on_a_display_that_is_no_longer_attached() {
    let frame = Frame { x: -2000, y: 300, width: 1400, height: 900 };

    assert!(frame.is_big_enough());
    assert_eq!(frame.worth_restoring(&[laptop(), second_display()]), Some(frame));
    // Unplug it.
    assert_eq!(frame.worth_restoring(&[laptop()]), None);
}

/// A sliver on the screen is not a window somebody can get hold of.
#[test]
fn refuses_a_frame_with_only_a_corner_on_a_screen() {
    let barely = Frame { x: 2560 - 40, y: 1600 - 10, width: 1400, height: 900 };

    assert!(!barely.is_reachable(&[laptop()]));
    assert_eq!(barely.worth_restoring(&[laptop()]), None);
}

/// Enough title bar to drag by is enough.
#[test]
fn accepts_a_frame_hanging_off_the_edge_by_most_of_itself() {
    let mostly_off = Frame { x: 2560 - 300, y: 1600 - 200, width: 1400, height: 900 };

    assert!(mostly_off.is_reachable(&[laptop()]));
}

/// A window the interface does not fit in is not restored even where it is.
///
/// Zero and near-zero sizes are what a window reports while it is opening or
/// minimised, and writing one down means next launch opens a sliver.
#[test]
fn refuses_a_frame_too_small_to_use() {
    for (width, height) in [(0, 0), (1, 1), (MIN_WIDTH as u32 - 1, 900), (1400, MIN_HEIGHT as u32 - 1)]
    {
        let frame = Frame { x: 100, y: 100, width, height };
        assert!(!frame.is_big_enough(), "{width}x{height}");
        assert_eq!(frame.worth_restoring(&[laptop()]), None, "{width}x{height}");
    }
}

/// With no displays reported at all, nothing is restored.
///
/// `available_monitors` answering with an empty list is a failure to ask, and
/// trusting a stored position against no evidence is the off-screen case again.
#[test]
fn refuses_everything_when_it_cannot_see_a_screen() {
    let frame = Frame { x: 200, y: 100, width: 1400, height: 900 };

    assert_eq!(frame.worth_restoring(&[]), None);
}
