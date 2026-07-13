import { AuthProvider, useAuth } from "./auth/useAuth";
import { LoginView } from "./auth/LoginView";
import { AppRoot } from "./shell/AppRoot";

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

function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

export default App;
