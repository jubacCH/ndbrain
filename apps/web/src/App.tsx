import { AuthProvider, useAuth } from "./auth/useAuth";
import { LoginView } from "./auth/LoginView";
import { AppRoot } from "./shell/AppRoot";
import { AddSourceView } from "./sources/AddSourceView";
import { SourcesProvider } from "./sources/SourcesProvider";
import { useSources } from "./sources/useSources";
import { isTauri } from "./platform/tauri";

function Gate() {
  const { loading, authenticated } = useAuth();

  if (loading) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  if (!authenticated) {
    return <LoginView />;
  }

  return <AppRoot />;
}

/** The normal authed/unauthed app, unchanged from before Plan 8's source
 *  registry - mounts `AuthProvider`, whose first effect is a session probe
 *  (`GET /notes`) against `getApiBaseUrl()`. Wiring this up to a specific
 *  source's own client/base-url (rather than the single global
 *  `getApiBaseUrl()`) is a later task - see `SourcesProvider`'s doc comment. */
function AuthedShell() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

/** Tauri-only gate in front of `AuthedShell`: before any source has been
 *  configured (`sources.length === 0`), renders `<AddSourceView>` instead,
 *  which replaces both the old server-url-only first run screen and the
 *  separate device-local-notes-only mode with a single "add a source"
 *  screen offering either a server or a local folder as a first-class
 *  source. Once at least one source exists, falls through to the
 *  normal shell - no explicit re-render wiring needed, since `sources` is
 *  reactive context state that already changes (and re-renders this
 *  component) the moment `addServer`/`addFolder` succeeds. */
function TauriGate() {
  const { sources } = useSources();

  if (sources.length === 0) {
    return <AddSourceView onDone={() => {}} />;
  }

  return <AuthedShell />;
}

/** Top-level app gate.
 *
 *  In the browser (`!isTauri()`), this renders `<AuthedShell>` unconditionally
 *  - zero behavior change from before Plan 8's source registry: the browser
 *  always has exactly one implicit origin source (see `SourcesProvider`'s doc
 *  comment), so `TauriGate` is never even mounted there, and `<AddSourceView>`
 *  is therefore never rendered in the browser (see `App.test.tsx`, unmodified
 *  and still green).
 *
 *  `<SourcesProvider>` wraps the whole tree unconditionally - it is a no-op
 *  in the browser (no `localStorage` reads/writes, no extra UI beyond its own
 *  internal session probe of the implicit origin source), so mounting it
 *  there is safe. */
function App() {
  return <SourcesProvider>{isTauri() ? <TauriGate /> : <AuthedShell />}</SourcesProvider>;
}

export default App;
