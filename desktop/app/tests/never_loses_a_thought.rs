//! The promise, at the one place it can be broken.
//!
//! `reply_for` turns what the server said into what the panel does, and
//! `saved: true` is the only value that lets the panel clear its field. So this
//! is the chokepoint: a `saved: true` reached from anything other than a written
//! note is a thought thrown away, and no amount of care elsewhere recovers it.

use ndbrain_capture::Outcome;
use ndbrain_desktop::reply_for;

#[test]
fn clears_the_field_only_for_a_note_that_was_written() {
    let saved = reply_for(Outcome::Saved {
        path: "50_Journal/2026/10/2026-10-01.md".into(),
        created: true,
    });

    assert!(saved.saved);
    assert!(!saved.needs_sign_in);
    // The path, because "saved" alone does not say whether it went where it was meant to.
    assert!(saved.message.contains("50_Journal/2026/10/2026-10-01.md"), "{}", saved.message);
}

#[test]
fn says_whether_the_day_was_started_or_added_to() {
    let path = "50_Journal/2026/10/2026-10-01.md";
    let started = reply_for(Outcome::Saved { path: path.into(), created: true });
    let added = reply_for(Outcome::Saved { path: path.into(), created: false });

    assert_ne!(started.message, added.message);
}

/// Every other answer keeps the thought. This is the list of ways a capture can
/// go wrong, and none of them may clear the field.
#[test]
fn keeps_the_thought_for_every_other_answer() {
    let others = [
        Outcome::SignInNeeded,
        Outcome::SlowDown { seconds: Some(45) },
        Outcome::SlowDown { seconds: None },
        Outcome::Failed { message: "cannot reach ndBrain".into() },
        Outcome::Failed { message: String::new() },
    ];

    for outcome in others {
        let reply = reply_for(outcome.clone());
        assert!(!reply.saved, "{outcome:?} must not clear the field");
    }
}

/// An expired session asks for a password without taking the thought away.
#[test]
fn asks_for_a_password_without_discarding_what_was_typed() {
    let reply = reply_for(Outcome::SignInNeeded);

    assert!(reply.needs_sign_in);
    assert!(!reply.saved);
    assert!(!reply.message.is_empty(), "the panel has to say why it is asking");
}

/// A wait is a wait, not a sign-in prompt: a 429 means try again, and sending
/// somebody to a password field for it would be an invitation to make it worse.
#[test]
fn tells_a_wait_apart_from_an_expired_session() {
    let reply = reply_for(Outcome::SlowDown { seconds: Some(45) });

    assert!(!reply.needs_sign_in);
    assert!(reply.message.contains("45"), "{}", reply.message);
}

/// Whatever went wrong, the panel has something to put under the field. An empty
/// status line next to text that did not send is the worst of both.
#[test]
fn always_has_something_to_say() {
    let answers = [
        Outcome::SignInNeeded,
        Outcome::SlowDown { seconds: None },
        Outcome::Failed { message: "anything".into() },
    ];
    for outcome in answers {
        assert!(!reply_for(outcome).message.is_empty());
    }
}

/* ---- and the window that must not go away quietly ----------------------- */

/// `⌘W` must not put the capture panel away.
///
/// The panel refuses `esc` while it holds unsent text, because hiding it then is
/// exactly how a thought is lost without anybody noticing. An application menu
/// — which the main window needs, or there is no ⌘C and no ⌘V in it — brings
/// `⌘W` along, and `⌘W` knows nothing about the field. So a close request on the
/// panel is left to the panel, which is the half that knows.
#[test]
fn refuses_to_put_the_panel_away_on_a_close_request() {
    assert_eq!(ndbrain_desktop::closing("capture"), ndbrain_desktop::Closing::LeaveItToTheWindow);
}

/// The main window has nothing in it that is not on the server.
#[test]
fn hides_the_main_window_on_a_close_request() {
    assert_eq!(ndbrain_desktop::closing("main"), ndbrain_desktop::Closing::PutItAway);
}
