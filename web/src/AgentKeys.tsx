/**
 * The table of agent keys and the form that makes one.
 *
 * Two screens show them: the administrator's, for any account, and a person's
 * own settings, for themselves. They are one component and not two copies —
 * the difference between the screens is whose keys are listed and whether a key
 * with no deadline may be asked for, and both of those are arguments. A second
 * copy would be free to grow a second idea of what a scope means or of how
 * loudly the secret is handed over, and the one that mattered would be whichever
 * the reader did not have open.
 *
 * The secret is the part worth reading. Only its SHA-256 is stored, so the
 * response that creates it is the only time it will ever exist — which the
 * interface has to make impossible to miss rather than merely mention.
 */

import { useState } from 'react';

import { KEY_EXPIRY_WARNING_DAYS } from '../../shared/schema';
import { type ApiKey } from './api';
import { copy } from './copy';

/** A date, for the key table and for the account list beside it. */
export function when(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * When a key runs out, said loudly only while there is something to do.
 *
 * Inside the warning window it reads in days rather than as a date, for the
 * same reason the server's log line does: a date needs arithmetic before
 * anybody knows whether to act on it, and what is being prevented is a key
 * running out with nobody having noticed. Further out, the date is the more
 * useful thing to see. A revoked key is past mattering either way, so its
 * deadline is not dressed up as something to act on.
 */
export function Deadline({ value, now }: { value: ApiKey; now: number }): React.JSX.Element {
  const dim = (text: string): React.JSX.Element => <span className="dim">{text}</span>;

  if (value.expiresAt === null) return dim(copy.admin.noExpiry);
  if (value.revoked) return dim(when(value.expiresAt));
  if (value.expiresAt <= now) return <span className="pill p-crit">{copy.admin.expired}</span>;

  const days = Math.ceil((value.expiresAt - now) / 86_400_000);
  if (days > KEY_EXPIRY_WARNING_DAYS) return dim(when(value.expiresAt));
  return <span className="pill p-warn">{copy.admin.expiresIn(days)}</span>;
}

export function KeyTable({
  keys,
  busy,
  onRevoke,
}: {
  keys: ApiKey[];
  busy: boolean;
  /** Asks first, then revokes. The confirmation is the caller's, so the two
      screens can word it for who is reading. */
  onRevoke: (key: ApiKey) => void;
}): React.JSX.Element {
  // Read once per render rather than per row, so every deadline in the table is
  // measured against the same moment.
  const now = Date.now();

  if (keys.length === 0) return <p className="empty">{copy.admin.noKeys}</p>;

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>{copy.admin.keyName}</th>
          <th>{copy.admin.scope}</th>
          <th>{copy.admin.expires}</th>
          <th>{copy.admin.lastUsed}</th>
          <th className="n">{copy.admin.actions}</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key.id} data-disabled={key.revoked}>
            <td>
              {key.name}
              {key.canWrite && <span className="pill p-warn">{copy.admin.canWrite}</span>}
              {key.revoked && <span className="pill p-crit">{copy.admin.revoked}</span>}
            </td>
            <td className="dim">{key.scope === '' ? copy.admin.wholeVault : key.scope}</td>
            <td>
              <Deadline value={key} now={now} />
            </td>
            <td className="dim">{key.lastUsedAt === null ? copy.admin.never : when(key.lastUsedAt)}</td>
            <td className="n">
              {!key.revoked && (
                <button type="button" className="danger" disabled={busy} onClick={() => onRevoke(key)}>
                  {copy.admin.revoke}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function NewKey({
  busy,
  onCreate,
  allowForever = false,
}: {
  busy: boolean;
  /**
   * Makes the key and hands back the secret. Which vault it lands in is the
   * caller's business: the administrator's screen picks an account, a person's
   * own settings never ask, because there is nothing to ask.
   */
  onCreate: (
    name: string,
    scope: string,
    canWrite: boolean,
    expiresInDays?: number | null,
  ) => Promise<ApiKey & { secret: string }>;
  /**
   * Whether "until revoked" is on the list.
   *
   * Off for a key somebody makes for themselves. A key with no deadline is a
   * decision about a machine somebody operates — the job that runs once a month
   * — and the server refuses one on that route anyway; offering it here would
   * be a control that fails on submit.
   */
  allowForever?: boolean;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [lifetime, setLifetime] = useState('365');
  const [secret, setSecret] = useState<string | null>(null);

  if (secret !== null) {
    return (
      <div className="secretbox">
        <p className="secrettitle">{copy.admin.secretOnce}</p>
        <p className="setnote">{copy.admin.secretWhy}</p>
        <textarea readOnly value={secret} rows={2} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={() => setSecret(null)}>
          {copy.admin.gotIt}
        </button>
      </div>
    );
  }

  return (
    <form
      className="adminform"
      onSubmit={(event) => {
        event.preventDefault();
        // `forever` goes as null, a number of days as itself. Never undefined:
        // this form has a visible answer, so it says which one was chosen
        // rather than leaving the server to guess a default.
        const expiresInDays = lifetime === 'forever' ? null : Number(lifetime);
        void onCreate(name.trim(), scope.trim(), canWrite, expiresInDays).then((created) => {
          setSecret(created.secret);
          setName('');
          setScope('');
          setCanWrite(false);
          setLifetime('365');
        });
      }}
    >
      <h4>{copy.admin.newKey}</h4>
      <label>
        <span>{copy.admin.keyName}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={copy.admin.keyNameExample} required />
      </label>
      <label>
        <span>{copy.admin.scope}</span>
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder={copy.admin.wholeVault} />
      </label>
      <label>
        <span>{copy.admin.lifetime}</span>
        {/* A year is preselected, and "until revoked" is one option among four
            rather than the default — the key nobody renews is the one that
            outlives whatever it was made for. */}
        <select value={lifetime} aria-label={copy.admin.lifetime} onChange={(e) => setLifetime(e.target.value)}>
          <option value="365">{copy.admin.lifetimeYear}</option>
          <option value="90">{copy.admin.lifetimeQuarter}</option>
          <option value="30">{copy.admin.lifetimeMonth}</option>
          {allowForever && <option value="forever">{copy.admin.lifetimeForever}</option>}
        </select>
      </label>
      <p className="setnote">{copy.admin.lifetimeExplain}</p>
      <label className="checkline">
        <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} />
        <span>{copy.admin.mayWrite}</span>
      </label>

      <button type="submit" disabled={busy || name.trim() === ''}>
        {copy.admin.createKey}
      </button>
    </form>
  );
}
