//! What the client decides before and after the network does anything.
//!
//! Everything here is about one promise: a thought is cleared from the panel
//! only when the server has written it down. The decision that enforces it is
//! `classify`, and the rest of this file is the ways the address or the sign-in
//! can be wrong in a manner that would otherwise be silent.

use ndbrain_capture::{
    base_url, capture_body, classify, classify_login, session_token, BaseUrlError, CaptureError,
    LoginOutcome, Outcome, SESSION_COOKIE,
};

/// The cookie name is the server's, and this is the only copy of it over here.
///
/// `server/src/http/cookie.ts` is a module holding one line, which is what makes
/// reading it from a test reasonable. Done at compile time, so moving that file
/// breaks the build rather than the capture.
#[test]
fn spells_the_session_cookie_the_way_the_server_does() {
    let source = include_str!("../../../server/src/http/cookie.ts");
    assert!(
        source.contains(&format!("= '{SESSION_COOKIE}'")),
        "server/src/http/cookie.ts no longer says {SESSION_COOKIE}; this client would send a cookie nothing reads"
    );
}

mod addresses {
    use super::*;

    #[test]
    fn accepts_https_and_drops_the_trailing_slash() {
        assert_eq!(base_url("https://ndbrain.b8n.ch").unwrap(), "https://ndbrain.b8n.ch");
        assert_eq!(base_url("https://ndbrain.b8n.ch/").unwrap(), "https://ndbrain.b8n.ch");
        assert_eq!(base_url("  https://ndbrain.b8n.ch//  ").unwrap(), "https://ndbrain.b8n.ch");
    }

    /// The trap from `CT 132 — ndBrain`, turned around.
    ///
    /// Over plain HTTP a browser discards the `Secure` session cookie without a
    /// word. A native client does not: it reads the header itself and would send
    /// the session token in clear text over the network, which is worse than the
    /// browser's silence. So it is refused here instead.
    #[test]
    fn refuses_plain_http_to_anywhere_but_this_machine() {
        assert_eq!(base_url("http://ndbrain.b8n.ch"), Err(BaseUrlError::PlainHttp));
        assert_eq!(base_url("http://10.10.30.98:3000"), Err(BaseUrlError::PlainHttp));
    }

    /// `NDBRAIN_COOKIE_SECURE=false` against a server on this machine is the
    /// documented development case, and nothing leaves the loopback interface.
    #[test]
    fn allows_plain_http_to_this_machine() {
        for address in ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"] {
            assert!(base_url(address).is_ok(), "{address} should be allowed");
        }
    }

    /// `ndbrain.b8n.ch` with no scheme is the likeliest thing to be typed, and
    /// guessing `https` for it would also guess `http` for the next one.
    #[test]
    fn refuses_an_address_without_a_scheme() {
        assert_eq!(base_url("ndbrain.b8n.ch"), Err(BaseUrlError::NoScheme));
        assert_eq!(base_url(""), Err(BaseUrlError::NoScheme));
    }

    /// A host that merely *starts* with a loopback name is not this machine.
    #[test]
    fn is_not_fooled_by_a_host_that_begins_like_loopback() {
        assert_eq!(base_url("http://localhost.b8n.ch"), Err(BaseUrlError::PlainHttp));
        assert_eq!(base_url("http://127.0.0.1.b8n.ch"), Err(BaseUrlError::PlainHttp));
    }

    #[test]
    fn puts_the_capture_route_on_the_end() {
        let base = base_url("https://ndbrain.b8n.ch/").unwrap();
        assert_eq!(ndbrain_capture::capture_url(&base), "https://ndbrain.b8n.ch/api/v1/capture");
        assert_eq!(ndbrain_capture::login_url(&base), "https://ndbrain.b8n.ch/api/v1/auth/login");
    }
}

mod bodies {
    use super::*;

    #[test]
    fn sends_the_thought_and_the_day() {
        let body = capture_body("Ein Gedanke.", "2026-10-01").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(parsed["content"], "Ein Gedanke.");
        assert_eq!(parsed["date"], "2026-10-01");
    }

    /// Edges trimmed, the inside left alone: a textarea collects a trailing
    /// newline from the Return that was not `⌘↵`, and a thought is still the
    /// person's own wording in the middle.
    #[test]
    fn trims_the_edges_and_keeps_the_middle() {
        let body = capture_body("\n  Erste Zeile\n\n  Zweite  \n\n", "2026-10-01").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(parsed["content"], "Erste Zeile\n\n  Zweite");
    }

    /// Caught here rather than by the server's `content.min(1)`: a round trip to
    /// be told that a blank field is blank is a round trip for nothing.
    #[test]
    fn refuses_a_thought_that_is_only_whitespace() {
        assert_eq!(capture_body("   \n\t ", "2026-10-01"), Err(CaptureError::Empty));
        assert_eq!(capture_body("", "2026-10-01"), Err(CaptureError::Empty));
    }

    /// Quotes and backslashes go through `serde_json`, not through a format
    /// string. A thought containing a quotation mark is an ordinary thought.
    #[test]
    fn escapes_what_a_thought_may_contain() {
        let body = capture_body("Sie sagte \"ja\" — C:\\temp\n", "2026-10-01").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["content"], "Sie sagte \"ja\" — C:\\temp");
    }
}

mod answers {
    use super::*;

    #[test]
    fn reads_a_written_note_out_of_a_201() {
        let body = r#"{"created":true,"note":{"path":"50_Journal/2026/10/2026-10-01.md"}}"#;
        assert_eq!(
            classify(201, body, None),
            Outcome::Saved { path: "50_Journal/2026/10/2026-10-01.md".into(), created: true }
        );
    }

    #[test]
    fn reads_an_added_thought_out_of_a_200() {
        let body = r#"{"created":false,"note":{"path":"50_Journal/2026/10/2026-10-01.md"}}"#;
        assert_eq!(
            classify(200, body, None),
            Outcome::Saved { path: "50_Journal/2026/10/2026-10-01.md".into(), created: false }
        );
    }

    /// **The promise of the whole client.** Only a 2xx may ever clear the field,
    /// so every other answer has to come back as something that is not `Saved`.
    /// A 204, a 302 and a 200 whose body is not what this expects included: the
    /// first two are not this route answering, and the third is not an answer
    /// this can act on.
    #[test]
    fn never_calls_anything_but_a_written_note_saved() {
        let codes = [0, 100, 204, 301, 302, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504];
        for status in codes {
            let outcome = classify(status, r#"{"created":true,"note":{"path":"x.md"}}"#, None);
            assert!(
                !matches!(outcome, Outcome::Saved { .. }),
                "status {status} must not count as saved, got {outcome:?}"
            );
        }

        for body in ["", "not json", "{}", r#"{"created":true}"#, r#"{"note":{}}"#] {
            assert!(
                !matches!(classify(200, body, None), Outcome::Saved { .. }),
                "a 200 whose body is {body:?} must not count as saved"
            );
        }
    }

    #[test]
    fn asks_for_a_sign_in_on_401() {
        assert_eq!(classify(401, r#"{"code":"unauthenticated"}"#, None), Outcome::SignInNeeded);
    }

    /// The login brake answers 429 with `Retry-After`, and it protects the very
    /// person it shuts out — so the number is shown rather than swallowed.
    #[test]
    fn carries_the_wait_out_of_a_429() {
        assert_eq!(classify(429, "{}", Some("45")), Outcome::SlowDown { seconds: Some(45) });
        assert_eq!(classify(429, "{}", None), Outcome::SlowDown { seconds: None });
        assert_eq!(classify(429, "{}", Some("soon")), Outcome::SlowDown { seconds: None });
    }

    /// The server says what was wrong with a request in `message`. Repeating it
    /// beats "something went wrong", which is what a panel would otherwise show
    /// for a 400 the person could have fixed.
    #[test]
    fn repeats_what_the_server_said_went_wrong() {
        let outcome = classify(400, r#"{"code":"invalid_body","message":"date: not a day the calendar has"}"#, None);
        match outcome {
            Outcome::Failed { message } => assert!(message.contains("not a day the calendar has"), "{message}"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn says_something_for_a_server_that_said_nothing() {
        match classify(502, "<html>Bad Gateway</html>", None) {
            Outcome::Failed { message } => assert!(message.contains("502"), "{message}"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}

mod signing_in {
    use super::*;

    #[test]
    fn takes_the_token_out_of_the_set_cookie_header() {
        let headers = [
            "other=irrelevant; Path=/".to_string(),
            "ndbrain_session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax".to_string(),
        ];
        assert_eq!(session_token(&headers), Some("abc123".to_string()));
    }

    /// `clearCookie` sends the same name with an empty value. Storing that would
    /// turn "signed out" into a session that looks present and 401s forever.
    #[test]
    fn treats_a_cleared_cookie_as_no_cookie() {
        let headers = ["ndbrain_session=; Path=/; Max-Age=0".to_string()];
        assert_eq!(session_token(&headers), None);
    }

    /// Keeps looking past a header it cannot read.
    ///
    /// Headers arrive in whatever order the server sent them, and `?` on the
    /// split of the first one would have given up on the whole reply — reported
    /// as "the server sent no session cookie" when it had.
    #[test]
    fn keeps_looking_after_a_header_it_cannot_read() {
        let headers = [
            "malformed-with-no-equals-sign".to_string(),
            "ndbrain_session=tok; Secure".to_string(),
        ];
        assert_eq!(session_token(&headers), Some("tok".to_string()));
    }

    /// A cookie whose *attribute* is spelled like the name is not the name.
    #[test]
    fn reads_only_the_first_pair_of_a_header() {
        let headers = ["other=x; Path=/ndbrain_session=no".to_string()];
        assert_eq!(session_token(&headers), None);
    }

    #[test]
    fn signs_in_when_the_cookie_arrives() {
        let headers = ["ndbrain_session=tok; Secure".to_string()];
        assert_eq!(
            classify_login(200, &headers, "{}", None),
            LoginOutcome::Signed { token: "tok".into() }
        );
    }

    /// The documented trap, said out loud.
    ///
    /// `CT 132 — ndBrain`: over plain HTTP the login answers 200 and the cookie
    /// never arrives, so everything after it is 401 for a reason nothing names.
    /// `base_url` keeps this from happening by address; this keeps it from being
    /// a mystery if it happens any other way — a proxy eating `Set-Cookie`, say.
    #[test]
    fn names_a_200_that_brought_no_cookie_instead_of_failing_later() {
        assert_eq!(classify_login(200, &[], "{}", None), LoginOutcome::NoCookie);
        assert_eq!(classify_login(200, &["unrelated=1".to_string()], "{}", None), LoginOutcome::NoCookie);
    }

    #[test]
    fn tells_wrong_credentials_apart_from_a_broken_server() {
        assert_eq!(
            classify_login(401, &[], r#"{"code":"invalid_credentials"}"#, None),
            LoginOutcome::WrongCredentials
        );
        assert_eq!(classify_login(429, &[], "{}", Some("30")), LoginOutcome::SlowDown { seconds: Some(30) });
        assert!(matches!(classify_login(503, &[], "{}", None), LoginOutcome::Failed { .. }));
    }
}
