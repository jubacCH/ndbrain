# Mac client — the global quick-capture hotkey

Phase 8's open half. The PWA is done; what the browser cannot give is a key
combination that works while something else has the keyboard.

## What this is for, and what it therefore is not

The one thing a shell adds over the PWA is the global hotkey: a thought reaches
today's daily note without leaving the window it arrived in. Everything else the
PWA already does, including the part a shell is usually built for — the README
says ndBrain "installs to a home screen or a taskbar from the browser", and an
installed PWA on macOS is already a chromeless window with its own Dock icon.

So this does **not** embed a WebView of `https://ndbrain.b8n.ch`. That window
would be the PWA with a second code path behind it: a second place to be signed
in, a second cache to go stale, a second CSP to keep working, and nothing gained
that the installed PWA does not already have. The menu-bar item opens the real
app in the default browser instead, so there stays exactly one copy of it.

What ships:

- a menu-bar (accessory) app with no Dock icon and no window of its own;
- a global shortcut that shows a small capture panel over whatever is in front;
- the panel writes to today's daily note under `## Notizen` and disappears;
- the menu offers Capture, Open ndBrain (in the browser), Sign out, Quit.

## The three questions, answered before the code

### 1. Rust

`rustc 1.95.0` / `cargo 1.95.0` from Homebrew, verified on this machine. Tauri
2.12.1 needs 1.90. No `~/.cargo` cache yet, so the first build pays for the
whole dependency graph once.

### 2. How the client authenticates

**The call has to come from Rust, not from the panel's WebView.** Three findings,
each checked in the code rather than assumed:

- `/api/v1/*` is gated on the session cookie and nothing else
  (`server/src/http/server.ts`, the `onRequest` hook). There is no bearer path
  into it.
- the cookie is `SameSite=lax` by default (`server/src/config.ts`), and the API
  has no CORS at all — the comment above the static handler says so outright:
  "Served by the same origin as the API, which is why there is no CORS
  configuration". A panel at `tauri://localhost` is a different site, so a
  `fetch()` from it would be refused and would not carry the cookie anyway.

**Agent keys are the wrong credential here, and also the wrong operation.** They
authenticate `/mcp`, deliberately outside the session gate. And MCP's
`append_note` (`server/src/mcp/tools.ts`) takes only `path` and `content`: no
`section`, no `ifAbsent`. It appends at the end of the note and fails when the
note does not exist — so it can neither start today's note nor keep a thought out
of `## Links`. Beyond that, an agent key is a long-lived token scoped for agents
and logged as one; a person's own capture should be the person's own write.

**So:** the panel signs in once (`POST /api/v1/auth/login`), Rust reads the token
out of `Set-Cookie`, stores it in the macOS Keychain (`security-framework`,
generic password, service `ch.b8n.ndbrain`), and sends it as
`Cookie: ndbrain_session=…`. A 401 means the session expired; the panel asks
again and **keeps the text**.

**The HTTP trap, turned around.** `CT 132 — ndBrain` records that over plain HTTP
a browser discards the `Secure` cookie without a word: login answers 200, the
cookie never arrives, everything after is 401. A native client does *not* behave
that way — it reads the header itself and would happily send the session token in
clear text. That is worse than the browser's silence, so the client refuses a
`http://` base URL unless it is loopback (the documented
`NDBRAIN_COOKIE_SECURE=false` development case). And if a login answers 200 with
no session cookie, the panel says exactly that rather than failing later as 401.

### 3. Offline

No outbox, no local queue, no draft on disk. "Server-zentriert, keine lokalen
Kopien" is the decision the whole project hangs on, and a capture queue would be
a sync protocol with one entry.

The rule that replaces it: **the panel never discards text it did not place.**
Only a 2xx clears the field and hides the window. Anything else — offline, 401,
429, 5xx, timeout — leaves the text where it is, with a line saying what happened,
and `⌘↵` retries. `Esc` with unsent text does not hide the window; it says the
text has not been sent. `⌘⌫` clears it deliberately. So a thought is never
swallowed, and it is never parked somewhere it would quietly rot either.

## The one server change, and why it is on the server

The capture needs `journalPath(today)`, `NOTES_SECTION` and
`dailyNoteTemplate(today)`. Those live in `shared/journal.ts`, whose own header
says why there must be exactly one copy of that pattern: "Two hand-written copies
of that pattern would drift, and the drift would show up as every daily note
quietly lowering the health score." A Rust client cannot import it.

So the client does not learn the pattern. `POST /api/v1/capture` takes the text
and a calendar day and does the rest:

```
POST /api/v1/capture   { content: string, date: "YYYY-MM-DD", owner?: UserId }
```

The **day comes from the client**, because `localDate` is explicit that the note
somebody expects is the one for the date on their own clock, and the server runs
in the container's time zone. The date is validated against `parseIsoDate`, so
`2026-02-30` is a 400 rather than a note in `50_Journal/2026/02/`.

The route is a thin wrapper over the same `app.appendNote(…, { section, ifAbsent })`
call the web's quick capture makes. The web keeps its own path for now — it can
legitimately share `journal.ts`, and moving it over means touching `App.tsx`,
which is being refactored in parallel.

## Layout

```
desktop/
  Cargo.toml              workspace
  capture/                pure decisions, no tauri, no network — where the tests are
  client/                 the HTTP calls, over reqwest; loopback integration test
  app/                    the tauri binary: tray, shortcut, panel, keychain
  ui/capture.html         the panel, static, no bundler
```

`capture/` is a crate of its own so `cargo test -p ndbrain-capture` costs seconds
and the red/green loop does not compile Tauri.

## Build budget

This is a fanless MacBook Air that is busy with other work. One cold dependency
compile, no more: `cargo test` at the workspace root once (which both proves the
whole thing compiles and runs every test), then `cargo build` reusing those
artifacts. No release build. No signing or notarisation — there is no certificate
in this environment, and the finished delivery happens in Xcode.

## Steps

1. `shared/schema.ts`: `CaptureRequest`, with the date checked against `parseIsoDate`.
2. `server/test/capture.test.ts` red, then `POST /api/v1/capture` green.
3. `desktop/capture`: base-URL rule, login-reply reading, capture body, outcome
   classification — test first, and each test mutated to see it fail.
4. `desktop/client`: reqwest over those, plus a loopback integration test.
5. `desktop/app`: tray, shortcut, panel window, Keychain.
6. `desktop/ui/capture.html`: field, status line, sign-in, key handling.
7. One `cargo test`, one `cargo build`, `npm run typecheck`, both suites.
8. `README.md`: the "No desktop shell" paragraph is no longer true.
