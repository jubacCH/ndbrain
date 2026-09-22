/**
 * Sign-in.
 *
 * No sign-up link, because there is no self-registration: an administrator
 * creates accounts with the CLI. The form says so, so that a first-time visitor
 * does not hunt for a button that will never exist.
 *
 * It is also where a session goes to die, and that is the part worth reading.
 * An expired cookie used to replace the entire application with this form on
 * the next click, wordlessly — the same screen a first visit gets, so the only
 * available reading was "something has gone wrong with my vault". Now it says
 * which of the two happened.
 *
 * And it hands back the unsaved text. `window.__ndbrainPending` is where the
 * editor parks what has not reached the server; the crash box was the only
 * thing that ever read it, and an expired session tears the editor down just as
 * thoroughly as a render fault does. This is the last surface left standing, so
 * it is the only one that can make the offer — a paragraph is not worth losing
 * to a cookie timing out.
 */

import { useState, type FormEvent } from 'react';
import { copy } from './copy';

import { ApiError, api, type User } from './api';

export function Login({
  onSignedIn,
  expired = false,
}: {
  onSignedIn: (user: User) => void;
  /** Whether this form is here because a session ended rather than never began. */
  expired?: boolean;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Read once, at mount. Read on every render it would disappear the moment a
   * keystroke re-rendered the form, and a textarea somebody is copying out of
   * must not move under them.
   */
  const [pending] = useState(() => (expired ? (window.__ndbrainPending ?? null) : null));

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
          ? copy.login.tooMany
          : copy.login.wrong,
      );
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={(event) => void submit(event)}>
        <h1>ndBrain</h1>
        <p>{copy.login.noSelfService}</p>

        {expired && (
          <div className="error" role="status">
            {copy.login.expired}
          </div>
        )}

        {error !== null && <div className="error" role="alert">{error}</div>}

        {pending !== null && pending.content !== '' && (
          <div className="login-pending">
            <p>{copy.login.unsaved}</p>
            <p className="login-pending-path">{pending.path}</p>
            <textarea
              readOnly
              value={pending.content}
              spellCheck={false}
              aria-label={copy.login.unsavedLabel}
            />
          </div>
        )}

        <label>
          {copy.login.name}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label>
          {copy.login.password}
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="btn btn-solid" disabled={busy}>
          {busy ? copy.login.working : copy.login.signIn}
        </button>
      </form>
    </div>
  );
}
