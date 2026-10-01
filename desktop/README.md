# desktop — the Mac client

A menu-bar application whose reason to exist is one key combination: a thought
reaches today's daily note without leaving the window it arrived in.

## Why it does not show notes

It would be easy to load `https://ndbrain.b8n.ch` into a window here, and it
would be worth nothing. The PWA already installs from the browser as a chromeless
window with its own Dock icon, so a WebView would add a second place to be signed
in, a second cache to go stale and a second content-security policy to keep
working — in exchange for a window that already exists. The tray menu opens
ndBrain in the default browser, and there stays one copy of the app.

What the browser genuinely cannot do is answer a shortcut while another
application has the keyboard. That is the whole product.

## How it behaves

| | |
|---|---|
| `⌘⇧Space` | the panel appears over whatever is in front, focused |
| `⌘↵` | the thought goes under `## Notizen` in today's daily note |
| `esc` | puts the panel away — twice, if there is unsent text |
| `⌘⌫` | discards the text, deliberately |

The shortcut is in `settings.json` (below). If the combination is already taken
the registration fails, and the tray menu says so by name — a shortcut that
silently does nothing would leave somebody with a menu-bar icon and no idea why.

## The rule everything is arranged around

**A thought leaves the panel only once the server has written it down.**

`Outcome::Saved` is the one answer that clears the field, and it is only ever
reached from a 200 or 201 that named a note. Offline, an expired session, a
refusal, a reply that could not be read: all of them leave the text exactly where
it is, with a line underneath saying why, and `⌘↵` tries again.

There is deliberately **no outbox, no queue and no draft on disk.**
"Server-centred, no local copies" is the decision this project hangs on, and a
capture queue would be a sync protocol with one entry in it. The thought stays
visible in a window instead, which is the one place it cannot rot unnoticed —
which is also why `esc` does not put away a panel that still holds one.

## How it authenticates, and why not the other ways

The request is made from Rust, not from the panel's WebView, and that is forced
rather than chosen:

- `/api/v1/*` is gated on the session cookie and nothing else
  (`server/src/http/server.ts`, the `onRequest` hook).
- the cookie is `SameSite=lax` by default and the API has no CORS at all, so a
  `fetch()` from `tauri://localhost` would be refused and would not carry the
  cookie anyway.

**An agent key is the wrong credential and the wrong operation.** Agent keys
authenticate `/mcp`, deliberately outside that gate, and MCP's `append_note`
takes only `path` and `content` — no `section`, no `ifAbsent` — so it can neither
start today's note nor keep a thought out of `## Links`. It is also a long-lived
token scoped for agents and logged as one; a person's own capture should be the
person's own write.

So the panel signs in once, Rust reads the token out of `Set-Cookie`, and the
**macOS Keychain** holds it (service `ch.b8n.ndbrain`). The password is read from
the panel, sent, and dropped; it is never stored. A 401 means the session ended,
and the panel asks again without taking the thought away.

> **The HTTP trap, turned around.** `CT 132 — ndBrain` records that over plain
> HTTP a browser discards the `Secure` cookie without a word: the login answers
> 200, the cookie never arrives, everything after is 401. A native client does
> *not* behave that way — it reads the header itself and would put the session
> token on the wire in clear text, which is worse than the browser's silence. So
> `base_url` refuses `http://` to anywhere but loopback, and a login that answers
> 200 with no cookie is reported as exactly that.

> **One wrinkle of an unsigned build.** macOS binds a Keychain item to the binary
> that made it, by code signature. An ad-hoc-signed build has a new identity after
> every rebuild, so the first capture after one asks for permission again. Signing
> fixes it, and signing happens in Xcode.

## Why there is a server route for this

`POST /api/v1/capture` takes a thought and a calendar day, and works out the rest
— the journal path, the `## Notizen` heading, the template a new day starts with.
All three come from `shared/journal.ts`, which says in its own header why there
must be exactly one copy of them: "the drift would show up as every daily note
quietly lowering the health score." A Rust client cannot import that module, so it
does not learn the pattern; it asks.

The **day comes from the client**, because the note somebody expects a thought in
is the one for the date on their own clock and the server runs in the container's
time zone. It is read at the moment of sending, so a panel left standing across
midnight captures into the day the thought was actually sent in.

## Layout

```
capture/   Every decision, and no dependencies: addresses, bodies, what an
           answer means. `cargo test -p ndbrain-capture` costs seconds.
client/    The two requests, over reqwest. Tested against a loopback socket.
app/       The shell: tray, shortcut, panel window, Keychain, settings.
ui/        The panel. Static HTML, CSS and one module — no bundler.
icons.mjs  Adds an alpha channel to the PWA's icon, which Tauri insists on.
```

`capture/` is separate so the red/green loop over the decisions does not compile
Tauri. The panel's HTML holds **no words at all** — every label is an empty
element filled from `app/src/copy.rs` — which is what makes
`tests/one_language.rs` able to check the single-language rule rather than merely
state it, the same way `web/test/one-language.test.ts` does for the browser.

## Settings

`~/Library/Application Support/ch.b8n.ndbrain/settings.json`, created on first
sign-in. No secret is ever in it; the session token is in the Keychain.

```json
{
  "address": "https://ndbrain.b8n.ch",
  "shortcut": "CommandOrControl+Shift+Space",
  "account": "julian"
}
```

A file that cannot be read does not stop the app — its job is to be there when a
thought arrives — but the panel says what was wrong with it.

## Building

```bash
cargo test     # 51 tests across the three crates
cargo build    # an unsigned debug binary in target/debug/
```

Rust 1.90 or newer; Tauri 2.12 sets that floor. `cargo build` produces a binary,
not a bundle: `cargo tauri build` makes the `.app`, and signing and notarisation
need a certificate, so the shippable build happens in Xcode.
