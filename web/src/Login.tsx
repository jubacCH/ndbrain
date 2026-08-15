/**
 * Sign-in.
 *
 * No sign-up link, because there is no self-registration: an administrator
 * creates accounts with the CLI. The form says so, so that a first-time visitor
 * does not hunt for a button that will never exist.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, api, type User } from './api';

export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { user } = await api.login(name, password);
      onSignedIn(user);
    } catch (caught) {
      // The server deliberately gives one answer for a wrong name and a wrong
      // password; repeating that here rather than guessing keeps it that way.
      setError(
        caught instanceof ApiError && caught.status === 429
          ? 'Zu viele Versuche. Warte einen Moment.'
          : 'That name and password do not match.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={(event) => void submit(event)}>
        <h1>ndBrain</h1>
        <p>Konten legt der Administrator an — eine Registrierung gibt es bewusst nicht.</p>

        {error !== null && <div className="error">{error}</div>}

        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="btn btn-solid" disabled={busy}>
          {busy ? 'One moment…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
