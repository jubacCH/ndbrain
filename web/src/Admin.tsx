/**
 * Accounts and agent keys.
 *
 * Everything here needed a shell on the box until now — fine for one person, and
 * not fine the moment a second account is wanted or a key has to be revoked from
 * somewhere that is not the server room.
 *
 * The one screen in this application where a mistake is expensive, so it is
 * built to be slow in the right places. Creating an account and resetting
 * somebody's password both take a deliberate submit; disabling asks first and
 * says what it will do. Nothing here is a one-click action on a row.
 *
 * The key secret is the part worth reading. Only its SHA-256 is stored, so the
 * response that creates it is the only time it will ever exist — which the
 * interface has to make impossible to miss rather than merely mention.
 */

import { useState } from 'react';

import { KEY_EXPIRY_WARNING_DAYS } from '../../shared/schema';
import { ApiError, type AdminSpace, type AdminUser, type ApiKey } from './api';
import { AdminSpaces, type AdminSpacesProps } from './AdminSpaces';
import { copy } from './copy';

export interface AdminProps {
  users: AdminUser[];
  keys: ApiKey[];
  self: string;
  busy: boolean;
  onCreateUser: (id: string, password: string, displayName: string, admin: boolean) => Promise<void>;
  onResetPassword: (id: string, password: string) => Promise<void>;
  onSetDisabled: (id: string, disabled: boolean) => Promise<void>;
  onCreateKey: (
    owner: string,
    name: string,
    scope: string,
    canWrite: boolean,
    expiresInDays?: number | null,
  ) => Promise<ApiKey & { secret: string }>;
  onRevokeKey: (id: string) => Promise<void>;
  onPickOwner: (owner: string) => void;
  keyOwner: string;
  /** Spaces, their members, and what it takes to change them. */
  spaces: Omit<AdminSpacesProps, 'users' | 'busy'>;
}

function when(at: number): string {
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
function Deadline({ value, now }: { value: ApiKey; now: number }): React.JSX.Element {
  const dim = (text: string): React.JSX.Element => <span className="dim">{text}</span>;

  if (value.expiresAt === null) return dim(copy.admin.noExpiry);
  if (value.revoked) return dim(when(value.expiresAt));
  if (value.expiresAt <= now) return <span className="pill p-crit">{copy.admin.expired}</span>;

  const days = Math.ceil((value.expiresAt - now) / 86_400_000);
  if (days > KEY_EXPIRY_WARNING_DAYS) return dim(when(value.expiresAt));
  return <span className="pill p-warn">{copy.admin.expiresIn(days)}</span>;
}

export function AdminView(props: AdminProps): React.JSX.Element {
  const { users, keys, self, busy, keyOwner } = props;
  const spaces: AdminSpace[] = props.spaces.spaces;
  const spaceIds = new Set(spaces.map((space) => space.id));
  // A server that lists spaces among the accounts as well must not have them
  // offered as people, with a password to reset.
  const people = users.filter((user) => !spaceIds.has(user.id));
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  // Read once per render rather than per row, so every deadline in the table is
  // measured against the same moment.
  const now = Date.now();

  const guard = async (run: () => Promise<void>, ok: string): Promise<void> => {
    try {
      await run();
      setNote({ kind: 'ok', text: ok });
    } catch (caught) {
      setNote({ kind: 'bad', text: caught instanceof ApiError ? caught.message : copy.admin.failed });
    }
  };

  return (
    <div className="pane padded admin">
      <h2 className="h-big">{copy.admin.title}</h2>
      <p className="h-sub">{copy.admin.subtitle}</p>

      {/* The region, not the line: a `role="status"` mounted together with its
          one message has nothing to change and is never announced. */}
      <div role="status">
        {note !== null && <p className={note.kind === 'ok' ? 'setok' : 'setbad'}>{note.text}</p>}
      </div>

      <section className="setgroup">
        <h3 className="cap">{copy.admin.accounts}</h3>

        <table className="tbl">
          <thead>
            <tr>
              <th>{copy.admin.account}</th>
              <th className="n">{copy.admin.notes}</th>
              <th className="n">{copy.admin.keys}</th>
              <th>{copy.admin.since}</th>
              <th className="n">{copy.admin.actions}</th>
            </tr>
          </thead>
          <tbody>
            {people.map((user) => (
              <tr key={user.id} data-disabled={user.disabled}>
                <td>
                  <span className="adminname">{user.displayName}</span>
                  <span className="adminid">{user.id}</span>
                  {user.role === 'admin' && <span className="pill p-tag">{copy.admin.admin}</span>}
                  {user.disabled && <span className="pill p-crit">{copy.admin.disabled}</span>}
                </td>
                <td className="n">{user.notes}</td>
                <td className="n">{user.keys}</td>
                <td>{when(user.createdAt)}</td>
                <td className="n adminrow-actions">
                  <ResetPassword
                    user={user}
                    busy={busy}
                    onReset={(password) =>
                      guard(() => props.onResetPassword(user.id, password), copy.admin.passwordReset(user.id))
                    }
                  />
                  {/* Your own row offers no switch: an interface that lets an
                      administrator remove the only way back in has a hole where
                      a confirmation dialog was. */}
                  {user.id !== self && (
                    <button
                      type="button"
                      className={user.disabled ? '' : 'danger'}
                      disabled={busy}
                      onClick={() => {
                        if (!user.disabled && !window.confirm(copy.admin.confirmDisable(user.id))) return;
                        void guard(
                          () => props.onSetDisabled(user.id, !user.disabled),
                          user.disabled ? copy.admin.enabled(user.id) : copy.admin.disabledNow(user.id),
                        );
                      }}
                    >
                      {user.disabled ? copy.admin.enable : copy.admin.disable}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <NewAccount
          busy={busy}
          onCreate={(id, password, displayName, admin) =>
            guard(() => props.onCreateUser(id, password, displayName, admin), copy.admin.created(id))
          }
        />
      </section>

      <AdminSpaces {...props.spaces} users={users} busy={busy} />

      <section className="setgroup">
        <h3 className="cap">{copy.admin.agentKeys}</h3>
        <p className="setnote">{copy.admin.keysExplain}</p>

        <div className="setrow">
          <div className="setlabel">
            <span>{copy.admin.forAccount}</span>
          </div>
          <select value={keyOwner} aria-label={copy.admin.forAccount} onChange={(e) => props.onPickOwner(e.target.value)}>
            <optgroup label={copy.admin.people}>
              {people.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.id})
                </option>
              ))}
            </optgroup>
            {spaces.length > 0 && (
              <optgroup label={copy.admin.spacesGroup}>
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.displayName} ({space.id})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        {spaceIds.has(keyOwner) && <p className="setnote">{copy.admin.keysForSpace}</p>}

        {keys.length === 0 ? (
          <p className="empty">{copy.admin.noKeys}</p>
        ) : (
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
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(copy.admin.confirmRevoke(key.name))) return;
                          void guard(() => props.onRevokeKey(key.id), copy.admin.keyRevoked(key.name));
                        }}
                      >
                        {copy.admin.revoke}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <NewKey owner={keyOwner} busy={busy} onCreate={props.onCreateKey} />
      </section>
    </div>
  );
}

function ResetPassword({
  user,
  busy,
  onReset,
}: {
  user: AdminUser;
  busy: boolean;
  onReset: (password: string) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)}>
        {copy.admin.resetPassword}
      </button>
    );
  }

  return (
    <form
      className="inlineform"
      onSubmit={(event) => {
        event.preventDefault();
        void onReset(value).then(() => {
          setValue('');
          setOpen(false);
        });
      }}
    >
      <input
        type="password"
        autoComplete="new-password"
        minLength={10}
        placeholder={copy.admin.newPasswordFor(user.id)}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required
      />
      <button type="submit" disabled={busy || value.length < 10}>
        {copy.admin.set}
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        {copy.admin.cancel}
      </button>
    </form>
  );
}

function NewAccount({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (id: string, password: string, displayName: string, admin: boolean) => Promise<void>;
}): React.JSX.Element {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [admin, setAdmin] = useState(false);

  return (
    <form
      className="adminform"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate(id.trim(), password, displayName.trim() || id.trim(), admin).then(() => {
          setId('');
          setPassword('');
          setDisplayName('');
          setAdmin(false);
        });
      }}
    >
      <h4>{copy.admin.newAccount}</h4>
      {/* The id becomes the vault's folder name and can never change; the label
          says so here rather than in a tooltip nobody opens. */}
      <p className="setnote">{copy.admin.idIsPermanent}</p>

      <label>
        <span>{copy.admin.signInName}</span>
        <input value={id} onChange={(e) => setId(e.target.value)} required pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" />
      </label>
      <label>
        <span>{copy.admin.displayName}</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={id} />
      </label>
      <label>
        <span>{copy.admin.password}</span>
        <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <label className="checkline">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
        <span>{copy.admin.makeAdmin}</span>
      </label>

      <button type="submit" disabled={busy || id.trim() === '' || password.length < 10}>
        {copy.admin.create}
      </button>
    </form>
  );
}

/**
 * Creating a key, and showing it once.
 *
 * The secret is held in component state only until it is dismissed, and the
 * panel around it says plainly that there is no second chance — because there
 * genuinely is not one, and an interface that mentions this quietly is an
 * interface that will have somebody closing the tab too early.
 */
function NewKey({
  owner,
  busy,
  onCreate,
}: {
  owner: string;
  busy: boolean;
  onCreate: (
    owner: string,
    name: string,
    scope: string,
    canWrite: boolean,
    expiresInDays?: number | null,
  ) => Promise<ApiKey & { secret: string }>;
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
        void onCreate(owner, name.trim(), scope.trim(), canWrite, expiresInDays).then((created) => {
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
          <option value="forever">{copy.admin.lifetimeForever}</option>
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
