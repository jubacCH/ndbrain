import { useState } from "react";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { LoginView } from "./auth/LoginView";
import { AppRoot } from "./shell/AppRoot";
import { ServerUrlView } from "./settings/ServerUrlView";
import { getServerUrl } from "./api/base-url";
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

/** The normal authed/unauthed app, unchanged from before Task 5 - mounts
 *  `AuthProvider`, whose first effect is a session probe (`GET /notes`)
 *  against `getApiBaseUrl()`. This must never mount before a Tauri client has
 *  a server url configured (see `App`'s doc comment below), or that probe
 *  fires against an empty base url. */
function AuthedShell() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

/** Top-level app gate.
 *
 *  In the browser (`!isTauri()`), this renders `<AuthedShell>` unconditionally,
 *  exactly as before Task 5 introduced the desktop client - zero behavior
 *  change, byte-identical to the pre-Task-5 `App.tsx` (see `App.test.tsx`,
 *  unmodified and still green).
 *
 *  In the Tauri desktop shell before a server url has been configured
 *  (`getServerUrl() === null`), it renders `<ServerUrlView>` INSTEAD of
 *  `<AuthedShell>` - critically, `<AuthProvider>` is not mounted at all yet,
 *  so its session-probe effect never fires against an empty base url. Once
 *  `ServerUrlView` calls `onConnected` (a server url has been validated and
 *  persisted via `setServerUrl`), a local counter bump forces this component
 *  to re-render; `getServerUrl()` is now non-null, so it swaps in
 *  `<AuthedShell>`, which starts the normal login flow against the now
 *  configured server. */
function App() {
  const [, forceRerender] = useState(0);

  if (isTauri() && getServerUrl() === null) {
    return <ServerUrlView onConnected={() => forceRerender((n) => n + 1)} />;
  }

  return <AuthedShell />;
}

export default App;
