# ndBrain

Self-hosted, AI-first second brain. Notes are plain Markdown in a Git-backed
vault, served by a Node/Fastify server (`apps/server`) with a browser client
(`apps/web`) and an optional native desktop shell (`apps/desktop`, Tauri v2).
An MCP server exposes the same vault to AI agents.

## Development

```bash
pnpm install
pnpm -r build   # build all workspace packages
pnpm -r test    # run all test suites
```

Requires Node ≥22 and pnpm (see `pnpm-workspace.yaml`).

## Desktop app

### Building the desktop app

The desktop shell (`apps/desktop`, Tauri v2) loads the built web app as its
frontend (`frontendDist: "../../web/dist"` in
`apps/desktop/src-tauri/tauri.conf.json`), so `apps/web` must be built
*before* the Tauri build runs.

```bash
pnpm -F @ndbrain/web build
pnpm -F @ndbrain/desktop tauri build            # release bundle
pnpm -F @ndbrain/desktop tauri build --debug    # unsigned debug bundle
```

Both steps are wired up as a single root script:

```bash
pnpm desktop:build
```

On macOS this produces `ndBrain.app` and a `.dmg` under
`apps/desktop/src-tauri/target/{debug,release}/bundle/`; on other platforms
Tauri produces the equivalent native bundle (`.msi`/`.exe` on Windows,
`.deb`/`.AppImage` on Linux) under the same `target/<profile>/bundle/`
directory.

Prerequisites:

- Node ≥22, pnpm (see root `package.json` engines/workspace)
- A Rust toolchain (`rustc`/`cargo`) — install via [rustup](https://rustup.rs)
- Platform build tools for Tauri v2: Xcode command line tools on macOS,
  the MSVC Build Tools + WebView2 on Windows, or the usual GTK/WebKitGTK
  dev packages on Linux — see the
  [Tauri v2 prerequisites guide](https://v2.tauri.app/start/prerequisites/)

A debug build (`tauri build --debug`, unsigned) has been verified to
complete end-to-end in this repo and produces a working `.app`/`.dmg`
locally — see the Task 6 report for details. It is **not** signed or
notarized (see below).

### Configuring the server URL

The desktop app has no same-origin server to talk to — it loads local app
assets, not the ndBrain server. On first launch it shows a "Connect to your
ndBrain server" screen (`ServerUrlView`, `apps/web/src/settings/ServerUrlView.tsx`)
where you enter the URL of your self-hosted ndBrain server (e.g.
`https://brain.example.com`). The app pings `/api/v1/notes` to confirm the
server is reachable, then persists the URL and proceeds to the normal login
flow. This screen only ever appears inside the Tauri shell (`isTauri()`); the
browser build is unaffected and keeps using its same-origin server as today.

### Local notes (desktop only)

The desktop app has an additional "Local" area, only visible/active when
running inside Tauri, backed by a Markdown folder you pick on your own
device (`apps/web/src/local/`).

**Isolation guarantee:** local notes never touch the ndBrain server API, the
vault, or MCP/agents — there is no code path from the local-notes store
(`apps/web/src/local/localStore.ts`) to the server API. They exist purely on
your device. The only way a local note reaches the server is the explicit
**"Move to server"** action in the local notes view, which uploads that one
note and removes the local copy. Everything else (listing, reading, writing,
on-device search) stays local for the lifetime of the note.

### Signing & notarizing (manual — requires Julian's machine + Apple account)

This is **not** run by CI or by any automated verification — it requires a
paid Apple Developer account and must be run on a machine with the signing
identity installed. Treat the following as a runbook, not something already
executed.

**macOS (Developer ID + notarization):**

1. Have an Apple Developer Program membership and a "Developer ID
   Application" certificate installed in the local keychain.
2. Set signing identity/notarization credentials for Tauri, e.g. via
   environment variables or `tauri.conf.json > bundle.macOS.signingIdentity`:
   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
   export APPLE_ID="you@example.com"
   export APPLE_PASSWORD="<app-specific password>"
   export APPLE_TEAM_ID="<TEAMID>"
   ```
3. Build a release bundle: `pnpm -F @ndbrain/desktop tauri build` (Tauri
   signs the `.app` automatically when `APPLE_SIGNING_IDENTITY` is set).
4. Notarize with Apple's `notarytool` (built into Xcode ≥13):
   ```bash
   xcrun notarytool submit apps/desktop/src-tauri/target/release/bundle/dmg/ndBrain_*.dmg \
     --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" --wait
   xcrun stapler staple apps/desktop/src-tauri/target/release/bundle/dmg/ndBrain_*.dmg
   ```
5. Verify with `spctl -a -vvv --type install <path-to.app>`.

**Windows (Signtool):**

1. Obtain a code-signing certificate (EV or standard) from a CA, or use one
   already installed in the machine's certificate store.
2. Set the signing identity for Tauri (e.g.
   `tauri.conf.json > bundle.windows.certificateThumbprint` /
   `digestAlgorithm` / `timestampUrl`, or the `TAURI_SIGNING_*`/`signtool`
   env vars, depending on the Tauri version in use).
3. Build: `pnpm -F @ndbrain/desktop tauri build`. Tauri invokes `signtool.exe`
   (from the Windows SDK) automatically when a certificate is configured.
4. Verify with `signtool verify /pa <path-to.exe or .msi>`.

Store uploads (Mac App Store / Microsoft Store), if ever pursued, are a
separate, further manual step on top of the above and are out of scope here.
