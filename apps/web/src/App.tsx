import { AuthProvider, useAuth } from "./auth/useAuth";
import { LoginView } from "./auth/LoginView";

function AppShell() {
  const { loading, authenticated, username, logout } = useAuth();

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

  return (
    <main>
      <h1>ndBrain</h1>
      {/* username is only known after an in-session login() — a probe-only session
          (existing cookie on page reload) has no /whoami route to recover it from. */}
      <p>Welcome, {username ?? "back"}.</p>
      <button type="button" onClick={() => void logout()}>
        Log out
      </button>
    </main>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

export default App;
