//! What the Mac client decides, with nothing attached to it.
//!
//! No network, no window, no Tauri — so the decisions can be read and tested on
//! their own, and so the red/green loop over them does not compile a WebView.
//! The one rule everything here serves: **a thought leaves the panel only when
//! the server has written it down.** `Outcome::Saved` is the single answer that
//! lets the field be cleared, and it is only ever reached from a 2xx that named
//! a note.
//!
//! What this crate deliberately does *not* know: where today's note lives, what
//! heading a thought goes under, and what a new daily note starts with. All
//! three live in `shared/journal.ts`, which says in its own header that there
//! must be exactly one copy of them — so this client asks
//! `POST /api/v1/capture` and sends only the text and the day.

/// The server's session cookie. Pinned against `server/src/http/cookie.ts` by a
/// test, because this is the second place that name is written down.
pub const SESSION_COOKIE: &str = "ndbrain_session";

/* ---- the address ---------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaseUrlError {
    /// Plain HTTP to somewhere that is not this machine.
    PlainHttp,
    /// No `https://` or `http://` at the front.
    NoScheme,
}

impl BaseUrlError {
    /// What the panel shows. Says the reason, because "invalid address" sends
    /// somebody looking for a typo that is not there.
    pub fn message(&self) -> &'static str {
        match self {
            // The one trap in `CT 132 — ndBrain` that a native client makes
            // worse rather than better: a browser silently discards the `Secure`
            // session cookie over HTTP, while this client would read it off the
            // header and send it back in clear text.
            Self::PlainHttp => {
                "plain http would send the session token in clear text — use https://, \
                 or http:// only to localhost"
            }
            Self::NoScheme => "the address needs to start with https://",
        }
    }
}

/// Checks and tidies the server address the client was configured with.
///
/// Trailing slashes go, so the routes below can be appended without producing a
/// double slash that a proxy may or may not forgive.
pub fn base_url(raw: &str) -> Result<String, BaseUrlError> {
    let trimmed = raw.trim().trim_end_matches('/');

    if let Some(rest) = trimmed.strip_prefix("https://") {
        if rest.is_empty() {
            return Err(BaseUrlError::NoScheme);
        }
        return Ok(trimmed.to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("http://") {
        if is_loopback(rest) {
            return Ok(trimmed.to_string());
        }
        return Err(BaseUrlError::PlainHttp);
    }

    Err(BaseUrlError::NoScheme)
}

/// Whether the authority of a URL names this machine.
///
/// Compared against the whole host rather than with `starts_with`:
/// `localhost.b8n.ch` resolves wherever its owner says, and `127.0.0.1.b8n.ch`
/// is a name somebody can register.
fn is_loopback(authority: &str) -> bool {
    let authority = authority.split('/').next().unwrap_or("");

    let host = if let Some(rest) = authority.strip_prefix('[') {
        // `[::1]:3000` — the colons inside the brackets are the address.
        match rest.split_once(']') {
            Some((inside, _)) => inside,
            None => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };

    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Where a thought goes. See `server/src/http/server.ts`.
pub fn capture_url(base: &str) -> String {
    format!("{base}/api/v1/capture")
}

pub fn login_url(base: &str) -> String {
    format!("{base}/api/v1/auth/login")
}

/* ---- the request --------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    /// Nothing but whitespace. Refused here rather than by the server's
    /// `content.min(1)`, so a blank field costs no round trip.
    Empty,
}

impl CaptureError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::Empty => "nothing to capture yet",
        }
    }
}

/// The body of `POST /api/v1/capture`.
///
/// `date` is the device's own day, in `YYYY-MM-DD`, because the note somebody
/// expects to find a thought in is the one for the date on their own clock — the
/// server runs on the container's. It is not checked here: the server checks it
/// against `parseIsoDate`, which is the one place that knows what a day is.
///
/// Built through `serde_json` rather than with a format string, so a thought
/// containing a quotation mark is an ordinary thought.
pub fn capture_body(text: &str, date: &str) -> Result<String, CaptureError> {
    let content = text.trim();
    if content.is_empty() {
        return Err(CaptureError::Empty);
    }

    Ok(serde_json::json!({ "content": content, "date": date }).to_string())
}

/// The body of `POST /api/v1/auth/login`.
pub fn login_body(user: &str, password: &str) -> String {
    serde_json::json!({ "user": user.trim(), "password": password }).to_string()
}

/* ---- the answer --------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The thought is in that note. **The only variant that may clear the field.**
    Saved { path: String, created: bool },
    /// No session, or it expired. The text stays; the panel asks for a password.
    SignInNeeded,
    /// The login brake, or any other `Retry-After`.
    SlowDown { seconds: Option<u64> },
    /// Everything else, with whatever the server or the socket said about it.
    Failed { message: String },
}

/// What an answer to `POST /api/v1/capture` means.
///
/// Written so that `Saved` is unreachable except from a 200 or 201 that named a
/// note. A `status` of 0 means the request never got an answer at all — see
/// `ndbrain-client` — and lands in `Failed` like any other non-2xx.
pub fn classify(status: u16, body: &str, retry_after: Option<&str>) -> Outcome {
    if status == 200 || status == 201 {
        return match written_note(body) {
            Some((path, created)) => Outcome::Saved { path, created },
            // A 2xx this cannot read is not a reason to throw the thought away.
            None => Outcome::Failed {
                message: "the server answered without saying where the thought went".to_string(),
            },
        };
    }

    match status {
        401 => Outcome::SignInNeeded,
        429 => Outcome::SlowDown { seconds: retry_after.and_then(|value| value.trim().parse().ok()) },
        _ => Outcome::Failed { message: problem(status, body) },
    }
}

/// The note a `PutNoteResponse` names, when it names one.
fn written_note(body: &str) -> Option<(String, bool)> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let path = parsed.get("note")?.get("path")?.as_str()?;
    if path.is_empty() {
        return None;
    }
    let created = parsed.get("created")?.as_bool()?;
    Some((path.to_string(), created))
}

/// What went wrong, in the server's own words where it offered any.
///
/// `message` is where this API puts the reason — a 400 from the body schema says
/// which field and why — and repeating it beats "something went wrong" for the
/// cases somebody could act on. The status is appended when there is no message,
/// so a bare 502 from the proxy is still identifiable.
fn problem(status: u16, body: &str) -> String {
    let said = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|parsed| parsed.get("message")?.as_str().map(str::to_string))
        .filter(|message| !message.is_empty());

    match said {
        Some(message) => message,
        None if status == 0 => "the server did not answer".to_string(),
        None => format!("the server answered {status}"),
    }
}

/* ---- signing in --------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginOutcome {
    Signed { token: String },
    WrongCredentials,
    /// 200, and no session cookie — the trap, named rather than left to show up
    /// as a 401 on the next request.
    NoCookie,
    SlowDown { seconds: Option<u64> },
    Failed { message: String },
}

pub fn classify_login(
    status: u16,
    set_cookie: &[String],
    body: &str,
    retry_after: Option<&str>,
) -> LoginOutcome {
    if status == 200 {
        return match session_token(set_cookie) {
            Some(token) => LoginOutcome::Signed { token },
            None => LoginOutcome::NoCookie,
        };
    }

    match status {
        401 => LoginOutcome::WrongCredentials,
        429 => LoginOutcome::SlowDown { seconds: retry_after.and_then(|value| value.trim().parse().ok()) },
        _ => LoginOutcome::Failed { message: problem(status, body) },
    }
}

/// The session token out of the `Set-Cookie` headers of a login reply.
///
/// Only the first `name=value` pair of each header is a cookie; everything after
/// the first `;` is attributes, and an attribute spelled like the name is not the
/// name. An empty value is what `clearCookie` sends, and storing that would turn
/// a sign-out into a session that looks present and 401s forever.
pub fn session_token(set_cookie: &[String]) -> Option<String> {
    for header in set_cookie {
        let pair = header.split(';').next().unwrap_or("");
        // `continue`, not `?`: headers come in the order the server sent them,
        // and giving up on the whole reply because an earlier one is unreadable
        // would report "no session cookie" for a reply that carried one.
        let Some((name, value)) = pair.split_once('=') else { continue };
        if name.trim() == SESSION_COOKIE && !value.trim().is_empty() {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// The `Cookie` header a request carries, now that nothing stores it for us.
pub fn cookie_header(token: &str) -> String {
    format!("{SESSION_COOKIE}={token}")
}
