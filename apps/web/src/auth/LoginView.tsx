import { useId, useState, type FormEvent } from "react";
import { UnauthorizedError } from "../api/client";
import { useAuth } from "./useAuth";
import styles from "./LoginView.module.css";

/** Username/password sign-in form. Renders when `useAuth().authenticated` is false;
 *  on success the auth state flips and `App` swaps in the authed shell. */
export function LoginView() {
  const { login } = useAuth();
  const usernameId = useId();
  const passwordId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(
        err instanceof UnauthorizedError
          ? "Invalid username or password."
          : "Login failed. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={(e) => void handleSubmit(e)}>
        <h1 className={styles.brand}>ndBrain</h1>
        <p className={styles.subtitle}>Sign in to your second brain</p>

        <label className={styles.field} htmlFor={usernameId}>
          Username
          <input
            id={usernameId}
            name="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className={styles.field} htmlFor={passwordId}>
          Password
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
