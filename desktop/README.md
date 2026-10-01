# desktop — the Mac client

ndBrain as an application: a window with the notes in it, and a key combination
that reaches today's daily note from inside whatever else is in front.

## Why there is a window now

This started as a menu-bar utility with no WebView at all, on the argument that
an installed PWA is already a chromeless window with its own Dock icon — so a
second window would mean a second place to be signed in, a second cache to go
stale and a second content-security policy to keep working, in exchange for a
window that already exists.

The three costs are real. The exchange was not: what was wanted is an
application somebody keeps their notes in, not a shortcut that starts a browser.
A browser tab is where the notes lived; a tab is a thing that gets closed by
accident, lost behind forty others and reloaded by the wrong ⌘R. So the window
exists, and the three costs are paid rather than denied:

**One place to be signed in.** The WebView's cookie store and the Keychain item
the capture panel uses are genuinely two stores. They are kept to one session in
both directions, in `share_the_session`: a sign-in in the window is read out of
the WebView and put in the Keychain, so the panel can capture; a sign-in at the
panel is written into the WebView's store, so the window is already signed in.
Signing out clears both — a "Sign out" that signed out of one of two places
would be a false statement about the machine. Verified against the live server:
with a session in the Keychain and a fresh WebView store, the window answers
`/api/v1/auth/me` with 200 without anybody typing a password.

**One build at a time.** ndBrain is a single-page app without a router, so it
never navigates: a window left open goes on running the JavaScript it loaded,
straight through a deploy, with nothing on screen to say so. `web/src/build.ts`
records that happening in a browser tab, and a WebView that is never quit makes
it the normal case rather than the exception. So the entry module's content hash
— Vite names it `/assets/index-<hash>.js`, and the name changes exactly when the
code does — is compared against the one the server is serving every time the
window is focused. **Only a confirmed difference reloads**: a fetch that failed,
a proxy's error page and a reply that is not the page all read as `Unknown`, and
`Unknown` never reloads, because a reload fired on a network blink would throw
away whatever somebody was typing. Focus is the moment chosen because it is the
moment a reload costs least. ⌘R is in the View menu for the rest.

**No second content-security policy.** Tauri's `csp` applies to what Tauri
serves, which here is the capture panel alone. The main window is remote content
and keeps the policy the server sends with it, so there is one policy and
`server/src/http/csp.ts` is still the only place it is written. The main window
is also outside the IPC capability — `capabilities/default.json` names `capture`
and nothing else — so the page served over the network cannot invoke a command in
this process.

> **What a WKWebView actually does with that policy**, measured against the live
> server rather than assumed:
>
> - The inline theme bootstrap's `sha256` digest is honoured; the page mounts.
> - `connect-src 'self'` **does** admit a same-origin `wss://`. The collab
>   socket completed its handshake and was closed by the server's own handler.
>   The control in the same run — a socket to another origin — threw
>   `SecurityError` and reported a `connect-src` violation, so the directive is
>   being enforced rather than ignored.
> - Service workers register (WKWebView, not a browser), so `sw.js` applies:
>   navigations network-first, hashed assets cache-first. A reload after a deploy
>   therefore fetches the new page rather than the cached shell.
> - One violation is reported, and it is not this client's: `script-src` blocks
>   `eval` from the application bundle. It is Zod 4's JIT feature probe —
>   `try { Function("") } catch {}` — which is caught, falls back, and happens in
>   every browser too. The claim in `csp.ts` that nothing in the bundle evaluates
>   is out of date; `jitless` is the switch for it.

## What the menu bar is still for

A browser cannot answer a key combination while another application has the
keyboard. That is the half of this a WebView could never be, and it is unchanged:
`⌘⇧Space`, a panel over whatever is in front, a thought into today's note.

Closing the window does **not** quit the application, because quitting would take
the shortcut with it. Quit is in the menu, and in the tray.

`⌘W` closes the window. It deliberately does **nothing** to the panel: the panel
is put away by `esc`, which refuses while there is unsent text in it, and `⌘W`
knows nothing about the field. There was no menu to press it from before, so
this is the behaviour staying the same rather than changing.

### The Dock icon, which comes and goes

The brief was to leave `ActivationPolicy::Accessory` behind, and this keeps it
for exactly half the time: **`Regular` while the main window is visible,
`Accessory` while it is not.** That is a side effect of macOS rather than a
preference.

Showing the capture panel has to make it the key window, and `tao` does that
with `makeKeyAndOrderFront` followed by `activateIgnoringOtherApps:` — which
activates the *application*, bringing its other windows in front of whatever was
there. In a permanently `Regular` application, pressing `⌘⇧Space` over somebody
else's window would pop the whole of ndBrain over it, and putting the panel away
would leave them looking at ndBrain rather than at what they were doing. That is
the one promise the panel exists to keep.

So: with the window open there is a Dock icon, a place in ⌘-Tab and a menu bar,
because there is something to come back to. With the window closed there is
neither, and the panel behaves exactly as it did before any of this. The old
comment in `lib.rs` said a Dock icon for something that is only ever a panel
over somebody else's window is a lie about what it is — still true, and now only
true half the time. What it costs: while the window is open, the shortcut does
raise it. Accepted, because somebody with ndBrain open is not surprised to see
ndBrain.

The application menu is not decoration either. Without one, macOS gives a
WebView no Edit menu, and without an Edit menu there is no ⌘C and no ⌘V anywhere
in it — in a Mac application those are menu accelerators, not something a text
field supplies. An accessory application has no menu bar, which cost nothing
while the only window was a panel for one line of text.

### The menu-bar icon

`tray.rgba`, 36 pixels square, drawn by `icons.mjs` out of the same PNG as the
app icon. Three things about it were wrong at once, and all three produced the
same symptom — an icon its owner had to go looking for:

- it **was** the app icon, 512 pixels of near-white mark on a near-black ground;
- it was handed over without `icon_as_template`, so macOS drew that picture into
  the menu bar instead of filling the shape with a colour that contrasts;
- and it carried the app icon's margin, which a Dock tile needs and a menu bar
  supplies itself, so the mark inside the 18 points was smaller still.

The fourth thing was worse than any of them: the icon was attached with
`if let Some(icon) = app.default_window_icon()`, so an absent icon built a tray
**without** one and told nobody. That case no longer exists — the bytes are
`include_bytes!` and their length is a `const` assertion, so a missing or
malformed icon is a build that does not finish.

## How it behaves

| | |
|---|---|
| launch | the window opens where it was last left, in front |
| `⌘R` | fetches the page again, for a suspicion the automatic check missed |
| `⌘W` | puts the window away; the shortcut keeps working |
| `⌘Q` | quits, which is the only thing that stops the shortcut |
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

Signing in at the **window** instead goes the ordinary way, in the page, against
the same route — and the token lands in the Keychain anyway, read back out of the
WebView's cookie store on the next page load. The only password field somebody
has to meet twice is the one they choose to; see "One place to be signed in"
above.

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
           answer means, whether a window is behind the server.
           `cargo test -p ndbrain-capture` costs seconds.
client/    The three requests, over reqwest. Tested against a loopback socket.
app/       The shell: window, tray, shortcut, panel, menus, Keychain, settings.
           `tray.rs` is the menu-bar glyph, `frame.rs` the window's geometry.
ui/        The panel. Static HTML, CSS and one module — no bundler.
icons.mjs  Both icons, out of the PWA's: an RGBA app icon, which Tauri insists
           on, and a 36-pixel template for the menu bar, which is a different
           thing from a small app icon — see `app/src/tray.rs`.
bundle.mjs The `.app`: a plist, the binary, and an `.icns` of every size macOS
           asks for. `--install` puts it in /Applications.
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

`window.json` sits beside it and holds the main window's last position and size.
Its own file, because `settings.json` is three values somebody edits by hand and
this is state the application rewrites behind their back. A stored frame is
checked against the displays that are attached **now** before it is used: a
window restored onto a display that has been unplugged is off-screen, and an
application whose window opens where there is no screen looks exactly like one
that did not start.

## Building

```bash
cargo test                # 90 tests across the three crates
cargo build               # an unsigned debug binary in target/debug/
node icons.mjs            # only when the PWA's mark changes
node bundle.mjs --install # the .app, into /Applications
```

Rust 1.90 or newer; Tauri 2.12 sets that floor.

`cargo build` produces a binary, and macOS will not treat a binary as an
application: no Dock icon of its own, no Launchpad, no Spotlight. `bundle.mjs`
makes the `.app` — it exists because the first one was assembled by hand, and
the only record of how was a terminal's scrollback. Two things were wrong in it
and neither was visible: the `.icns` held a single size, so every place macOS
draws the icon larger or smaller scaled that one image, and the bundle was never
signed, only linker-signed, leaving its `Info.plist` unbound and its resources
unsealed.

It signs ad-hoc, which is well-formed and nothing more. Signing properly needs a
certificate and a certificate lives in Xcode, so that is still where a shippable
build happens.
