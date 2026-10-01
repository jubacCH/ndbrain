//! The two requests, against a socket that writes down what it was asked.
//!
//! A stub rather than a mocking library: the whole question here is what goes
//! out on the wire — whether the session token is attached as a `Cookie` header
//! at all, and whether the body is the one the server's schema accepts — and a
//! mock of reqwest would answer a different question.
//!
//! It listens on `127.0.0.1`, which is why `base_url` has its loopback exception:
//! plain HTTP to this machine is the one address where there is no session token
//! to leak.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use ndbrain_capture::{LoginOutcome, Outcome};
use ndbrain_client::Client;

/// What the stub saw, so a test can assert on the request rather than the reply.
struct Seen {
    target: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Serves one request with `status`, `headers` and `body`, and hands back what
/// it was sent.
///
/// `content-length` is counted here rather than written into each test. Getting
/// it wrong by hand truncates the body, and the symptom is a client that looks
/// broken while the stub is the thing that lied.
fn serve_once(
    status: &'static str,
    headers: &'static [&'static str],
    body: &'static str,
) -> (String, mpsc::Receiver<Seen>) {
    let mut reply = format!("HTTP/1.1 {status}\r\n");
    for header in headers {
        reply.push_str(header);
        reply.push_str("\r\n");
    }
    reply.push_str(&format!("content-length: {}\r\n", body.len()));
    reply.push_str("connection: close\r\n\r\n");
    reply.push_str(body);

    serve_raw(reply)
}

/// Serves exactly one request with a response written out byte for byte.
fn serve_raw(reply: String) -> (String, mpsc::Receiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::channel();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("one connection");
        let mut reader = BufReader::new(stream.try_clone().unwrap());

        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let target = request_line.split_whitespace().nth(1).unwrap_or("").to_string();

        let mut headers = Vec::new();
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap_or(0);
                }
                headers.push((name.trim().to_string(), value.trim().to_string()));
            }
        }

        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).unwrap();

        stream.write_all(reply.as_bytes()).unwrap();
        stream.flush().unwrap();

        let _ = send.send(Seen {
            target,
            headers,
            body: String::from_utf8_lossy(&body).to_string(),
        });
    });

    (address, receive)
}

const CAPTURED: &str = r#"{"created":true,"note":{"path":"50_Journal/2026/10/2026-10-01.md"}}"#;

#[tokio::test]
async fn sends_the_session_token_as_a_cookie_and_the_thought_as_json() {
    let (address, seen) = serve_once("201 Created", &["content-type: application/json"], CAPTURED);
    let client = Client::new(&address).expect("loopback http is allowed");

    let outcome = client.capture("tok123", "Ein Gedanke.", "2026-10-01").await.unwrap();

    let request = seen.recv().expect("the stub saw a request");
    assert_eq!(request.target, "/api/v1/capture");
    // The whole reason the request is made from Rust: a WebView could not attach
    // this, and the server's `/api/` gate accepts nothing else.
    assert_eq!(request.header("cookie"), Some("ndbrain_session=tok123"));
    assert_eq!(request.header("content-type"), Some("application/json"));

    let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["content"], "Ein Gedanke.");
    assert_eq!(body["date"], "2026-10-01");

    assert_eq!(
        outcome,
        Outcome::Saved { path: "50_Journal/2026/10/2026-10-01.md".into(), created: true }
    );
}

/// Several `Set-Cookie` lines, with the session's not first — the shape a reply
/// really has when anything else sets a cookie too.
#[tokio::test]
async fn picks_the_session_cookie_out_of_a_reply_that_sets_several() {
    let (address, seen) = serve_once(
        "200 OK",
        &[
            "set-cookie: consent=1; Path=/",
            "set-cookie: ndbrain_session=deadbeef; Path=/; HttpOnly; Secure; SameSite=Lax",
        ],
        "{}",
    );
    let client = Client::new(&address).unwrap();

    let outcome = client.login("julian", "ein gutes passwort").await;

    let request = seen.recv().unwrap();
    assert_eq!(request.target, "/api/v1/auth/login");
    let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["user"], "julian");
    assert_eq!(body["password"], "ein gutes passwort");

    assert_eq!(outcome, LoginOutcome::Signed { token: "deadbeef".into() });
}

/// The documented trap, over a real socket: 200 and no cookie.
///
/// `CT 132 — ndBrain` records that this is what a plain-HTTP login looks like
/// from a browser. The client names it rather than letting the next request come
/// back 401 for a reason nothing explains.
#[tokio::test]
async fn names_a_login_that_answered_200_without_a_cookie() {
    let (address, _seen) = serve_once("200 OK", &[], "{}");
    let client = Client::new(&address).unwrap();

    assert_eq!(client.login("julian", "x").await, LoginOutcome::NoCookie);
}

/// Nothing listening at all. This is the offline case, and the one that decides
/// whether a thought survives: it must come back as `Failed`, never as `Saved`.
#[tokio::test]
async fn keeps_the_thought_when_nothing_answers() {
    // A port that was bound and released: connecting to it is refused rather
    // than hanging, which is what being offline actually looks like here.
    let address = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let client = Client::new(&address).unwrap();

    let outcome = client.capture("tok", "Ein Gedanke.", "2026-10-01").await.unwrap();

    match outcome {
        Outcome::Failed { message } => assert!(!message.is_empty(), "a failure has to say something"),
        other => panic!("an unreachable server must not count as saved, got {other:?}"),
    }
}

/// Plain HTTP to anywhere else is refused before a socket is opened.
#[test]
fn will_not_build_a_client_for_plain_http_to_elsewhere() {
    assert!(Client::new("http://ndbrain.b8n.ch").is_err());
    assert!(Client::new("https://ndbrain.b8n.ch").is_ok());
}

/// The day follows the zone, which is the half of this that can be wrong.
///
/// Half past eleven at night in UTC is already the next day in Zurich, and the
/// note somebody expects a thought in is the one for the date on their own clock.
/// A fixed instant rather than `now()`, so the test does not only bite during the
/// two hours of the day when the two happen to disagree.
#[test]
fn reads_the_day_in_the_zone_of_the_moment_it_is_given() {
    use chrono::TimeZone;

    let instant = chrono::Utc.with_ymd_and_hms(2026, 10, 1, 23, 30, 0).unwrap();
    assert_eq!(ndbrain_client::day_of(&instant), "2026-10-01");

    let zurich = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
    assert_eq!(ndbrain_client::day_of(&instant.with_timezone(&zurich)), "2026-10-02");

    // And the other way round, so the test is not satisfied by always adding a day.
    let morning = chrono::Utc.with_ymd_and_hms(2026, 10, 2, 0, 30, 0).unwrap();
    let samoa = chrono::FixedOffset::west_opt(11 * 3600).unwrap();
    assert_eq!(ndbrain_client::day_of(&morning.with_timezone(&samoa)), "2026-10-01");
}

/// Padded to the width `parseIsoDate` insists on: `/^(\d{4})-(\d{2})-(\d{2})$/`.
#[test]
fn pads_the_day_the_way_the_server_parses_it() {
    use chrono::TimeZone;

    let instant = chrono::Utc.with_ymd_and_hms(26, 1, 2, 12, 0, 0).unwrap();
    assert_eq!(ndbrain_client::day_of(&instant), "0026-01-02");
}

/// `today` is the device's clock through `day_of`, and nothing else.
#[test]
fn takes_today_from_the_device_clock() {
    assert_eq!(ndbrain_client::today(), ndbrain_client::day_of(&chrono::Local::now()));
}
