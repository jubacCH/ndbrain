import { useState } from "react";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { LoginView } from "./auth/LoginView";
import { AppRoot } from "./shell/AppRoot";
import { LocalOnlyShell } from "./shell/LocalOnlyShell";
import { ServerUrlView } from "./settings/ServerUrlView";
import { getServerUrl } from "./api/base-url";
import { isLocalOnly, setLocalOnly } from "./local/localOnlyMode";
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
 *  In the Tauri desktop shell, two gates run before `<AuthedShell>`, both of
 *  which - critically - keep `<AuthProvider>` unmounted so its session-probe
 *  effect can never fire against an empty/wrong base url:
 *
 *  1. Local-only mode (`isLocalOnly()`, see `local/localOnlyMode.ts`) renders
 *     `<LocalOnlyShell>` instead of anything server-related at all. This is
 *     checked FIRST so a user who already opted into local-only skips the
 *     server url screen entirely on every subsequent launch.
 *  2. Otherwise, before a server url has been configured (`getServerUrl() ===
 *     null`), it renders `<ServerUrlView>`, which now also offers a "local
 *     notes only" escape hatch (`onUseLocalOnly`) alongside the normal
 *     `onConnected` path.
 *
 *  Both `ServerUrlView`'s `onConnected` and `onUseLocalOnly`, and
 *  `LocalOnlyShell`'s `onConnectServer`, funnel through the same local counter
 *  bump to force this component to re-render after persisting their choice
 *  (`setServerUrl`/`setLocalOnly`), so the gate above picks the next branch
 *  immediately without a full remount. */
function App() {
  const [, forceRerender] = useState(0);
  const rerender = () => forceRerender((n) => n + 1);

  if (isTauri()) {
    if (isLocalOnly()) {
      return (
        <LocalOnlyShell
          onConnectServer={() => {
            setLocalOnly(false);
            rerender();
          }}
        />
      );
    }

    if (getServerUrl() === null) {
      return (
        <ServerUrlView
          onConnected={rerender}
          onUseLocalOnly={() => {
            setLocalOnly(true);
            rerender();
          }}
        />
      );
    }
  }

  return <AuthedShell />;
}

export default App;
