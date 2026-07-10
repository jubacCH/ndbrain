import { AuthProvider, useAuth } from "./auth/useAuth";
import { LoginView } from "./auth/LoginView";
import { AppShell } from "./shell/AppShell";
import { AppStateProvider, useAppState } from "./shell/AppState";
import { NoteTree } from "./notes/NoteTree";

/** Main-slot placeholder until Task 6 renders the editor here, keyed on
 *  `selectedPath`. Reads AppState directly so App doesn't need to prop-drill it. */
function MainContent() {
  const { selectedPath } = useAppState();

  if (!selectedPath) {
    return <p>Select a note to start editing.</p>;
  }

  // Task 6 replaces this with the collaborative editor for `selectedPath`.
  return <p>Selected note: {selectedPath}</p>;
}

function AuthedShell() {
  const { username, logout } = useAuth();

  return (
    <AppStateProvider>
      <AppShell
        sidebar={<NoteTree />}
        main={<MainContent />}
        username={username}
        onLogout={() => void logout()}
      />
    </AppStateProvider>
  );
}

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

  return <AuthedShell />;
}

function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

export default App;
