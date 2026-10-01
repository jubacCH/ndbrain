//! The two requests the Mac client makes.
//!
//! Thin on purpose: every decision about what an answer means lives in
//! `ndbrain-capture`, and this crate only moves bytes and hands what came back
//! to `classify`. Nothing here may invent a `Saved`.
//!
//! **Why the request is made here rather than in the panel's WebView.** The
//! panel is served from `tauri://localhost`, which is a different site from
//! `https://ndbrain.b8n.ch`. The session cookie is `SameSite=lax` by default
//! (`server/src/config.ts`) so a browser would not attach it to a cross-site
//! request, and `/api/` has no CORS at all — the server's own comment says the
//! API "is served by the same origin as the API, which is why there is no CORS
//! configuration". So a `fetch()` from the panel cannot work by construction. A
//! native client sets the `Cookie` header itself and is not subject to either.

use std::time::Duration;

use ndbrain_capture::{
    base_url, bundle_fingerprint, capture_body, capture_url, classify, classify_login,
    cookie_header, login_body, login_url, BaseUrlError, CaptureError, LoginOutcome, Outcome,
};

/// How long a capture waits before it is reported as unanswered.
///
/// Short, and that is the point: this runs while somebody is standing in front of
/// a panel waiting to get back to what they were doing. A capture that has not
/// landed in ten seconds has not landed, and saying so and keeping the text beats
/// a spinner.
const TIMEOUT: Duration = Duration::from_secs(10);

pub struct Client {
    base: String,
    http: reqwest::Client,
}

#[derive(Debug)]
pub enum ClientError {
    Address(BaseUrlError),
    /// reqwest could not be built at all — no proxy resolver, no TLS backend.
    Transport(String),
}

impl ClientError {
    pub fn message(&self) -> String {
        match self {
            Self::Address(error) => error.message().to_string(),
            Self::Transport(detail) => detail.clone(),
        }
    }
}

impl Client {
    pub fn new(address: &str) -> Result<Self, ClientError> {
        let base = base_url(address).map_err(ClientError::Address)?;
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .map_err(|error| ClientError::Transport(error.to_string()))?;
        Ok(Self { base, http })
    }

    /// Signs in and hands back the session token for the Keychain to hold.
    pub async fn login(&self, user: &str, password: &str) -> LoginOutcome {
        let sent = self
            .http
            .post(login_url(&self.base))
            .header("content-type", "application/json")
            .body(login_body(user, password))
            .send()
            .await;

        match sent {
            Ok(response) => {
                let status = response.status().as_u16();
                // Collected before the body is consumed, and *all* of them: the
                // session cookie is not guaranteed to be the only one or the
                // first one.
                let cookies: Vec<String> = response
                    .headers()
                    .get_all(reqwest::header::SET_COOKIE)
                    .iter()
                    .filter_map(|value| value.to_str().ok().map(str::to_string))
                    .collect();
                let retry = header(&response, "retry-after");
                let body = response.text().await.unwrap_or_default();
                classify_login(status, &cookies, &body, retry.as_deref())
            }
            Err(error) => LoginOutcome::Failed { message: unreachable(&error) },
        }
    }

    /// Puts one thought into one day's note.
    ///
    /// `date` is the device's day at the moment of sending — see `today`. A
    /// transport failure is answered as `Outcome::Failed`, which is the branch
    /// that leaves the text in the panel.
    pub async fn capture(&self, token: &str, text: &str, date: &str) -> Result<Outcome, CaptureError> {
        let body = capture_body(text, date)?;

        let sent = self
            .http
            .post(capture_url(&self.base))
            .header("content-type", "application/json")
            .header(reqwest::header::COOKIE, cookie_header(token))
            .body(body)
            .send()
            .await;

        Ok(match sent {
            Ok(response) => {
                let status = response.status().as_u16();
                let retry = header(&response, "retry-after");
                let answer = response.text().await.unwrap_or_default();
                classify(status, &answer, retry.as_deref())
            }
            Err(error) => Outcome::Failed { message: unreachable(&error) },
        })
    }

    /// Which build the server is handing out right now, by the name of its
    /// entry module.
    ///
    /// Asked of `/`, which is outside the session gate, so this works before
    /// anybody has signed in and carries no cookie. Everything that could go
    /// wrong answers `None`: offline, a proxy's error page, a reply that is not
    /// the page. `freshness` turns `None` into `Unknown`, and `Unknown` never
    /// causes a reload — which is the property that matters, because a reload
    /// fired on a failed fetch would discard whatever was on screen.
    pub async fn served_bundle(&self) -> Option<String> {
        let response = self.http.get(format!("{}/", self.base)).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        bundle_fingerprint(&response.text().await.ok()?)
    }
}

fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response.headers().get(name)?.to_str().ok().map(str::to_string)
}

/// What to say about a request that never got an answer.
///
/// Offline is the case this exists for, and it is the one the panel must handle
/// without losing anything: `Failed` keeps the text where it is.
fn unreachable(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "the server did not answer in time — the thought is still here".to_string();
    }
    if error.is_connect() {
        return "cannot reach ndBrain — the thought is still here".to_string();
    }
    format!("{error}")
}

/// The calendar day a moment falls on, in that moment's own zone.
///
/// The zone is the whole point, which is why it is a parameter: `shared/journal.ts`
/// is explicit that "at half past midnight in Zurich it is already tomorrow there,
/// while UTC still says today — and the note somebody expects to open is the one
/// for the date on their own clock". Formatted the way `parseIsoDate` reads it.
pub fn day_of<Tz: chrono::TimeZone>(moment: &chrono::DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    moment.format("%Y-%m-%d").to_string()
}

/// The device's own day, right now.
///
/// `Local`, for the reason above. Read at the moment of sending rather than when
/// the panel opened, so a panel left standing across midnight captures into the
/// day the thought was actually sent in.
pub fn today() -> String {
    day_of(&chrono::Local::now())
}
