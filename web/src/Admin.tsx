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

import { ApiError, type AdminSpace, type AdminUser, type ApiKey } from './api';
import { AdminSpaces, type AdminSpacesProps } from './AdminSpaces';
import { KeyTable, NewKey, when } from './AgentKeys';
import { copy } from './copy';

export interface AdminProps {
  users: AdminUser[];
  keys: ApiKey[];
  self: string;
  busy: boolean;
  onCreateUser: (id: string, password: string, displayName: string, admin: boolean) => Promise<void>;
  onResetPassword: (id: string, password: string) => Promise<void>;
  onSetDisabled: (id: string, disabled: boolean) => Promise<void>;
  /** Changes an account's display name. The id is the vault's folder and stays. */
  onRenameUser: (
    id: string,
    fields: { displayName?: string; loginName?: string },
  ) => Promise<void>;
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

export function AdminView(props: AdminProps): React.JSX.Element {
  const { users, keys, self, busy, keyOwner } = props;
  const spaces: AdminSpace[] = props.spaces.spaces;
  const spaceIds = new Set(spaces.map((space) => space.id));
  // A server that lists spaces among the accounts as well must not have them
  // offered as people, with a password to reset.
  const people = users.filter((user) => !spaceIds.has(user.id));
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
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
              <th>{copy.admin.since}</th>
              <th className="n">{copy.admin.actions}</th>
            </tr>
          </thead>
          <tbody>
            {people.map((user) => (
              <tr key={user.id} data-disabled={user.disabled}>
                <td>
                  <span className="adminname">{user.displayName}</span>
                  <span className="adminid">{user.loginName}</span>
                  {/* The identifier, on this screen and on no other. Selectable
                      rather than offered with a copy button: it is wanted when
                      something is being looked up by hand, which is already a
                      terminal and a paste. */}
                  <code className="adminguid" title={copy.admin.guidWhy}>{user.id}</code>
                  {user.role === 'admin' && <span className="pill p-tag">{copy.admin.admin}</span>}
                  {user.disabled && <span className="pill p-crit">{copy.admin.disabled}</span>}
                </td>
                <td className="n">{user.notes}</td>
                <td>{when(user.createdAt)}</td>
                <td className="n adminrow-actions">
                  <Rename
                    user={user}
                    busy={busy}
                    onRename={(fields) =>
                      guard(() => props.onRenameUser(user.id, fields), copy.admin.renamed(user.loginName))
                    }
                  />
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

        {/* Spaces, and no account picker. Somebody's own agent keys are theirs;
            this screen used to list any account's because it was written when
            there was one account and an administrator who was also its owner. */}
        <p className="setnote">{copy.admin.keysArePersonal}</p>

        {spaces.length === 0 ? (
          <p className="empty">{copy.admin.noSpacesForKeys}</p>
        ) : (
          <>
            <div className="setrow">
              <div className="setlabel">
                <span>{copy.admin.forAccount}</span>
              </div>
              <select
                value={keyOwner}
                aria-label={copy.admin.forAccount}
                onChange={(e) => props.onPickOwner(e.target.value)}
              >
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.displayName} ({space.id})
                  </option>
                ))}
              </select>
            </div>
            <p className="setnote">{copy.admin.keysForSpace}</p>

        <KeyTable
          keys={keys}
          busy={busy}
          onRevoke={(key) => {
            if (!window.confirm(copy.admin.confirmRevoke(key.name))) return;
            void guard(() => props.onRevokeKey(key.id), copy.admin.keyRevoked(key.name));
          }}
        />

        {/* The administrator is the one who may make a key that never runs
            out, for the job that runs once a month. */}
            <NewKey
              busy={busy}
              allowForever
              onCreate={(name, scope, canWrite, expiresInDays) =>
                props.onCreateKey(keyOwner, name, scope, canWrite, expiresInDays)
              }
            />
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Changes what an account is called, not which account it is.
 *
 * The id beside the name in this table is the vault's folder on disk, so it is
 * the one thing here that cannot be edited — which is why this control is on
 * the display name and says so by starting from it rather than from an empty
 * field. The same shape as the password reset beside it: a button that opens a
 * field, because a row of permanently open inputs is a table somebody edits by
 * accident.
 */
function Rename({
  user,
  busy,
  onRename,
}: {
  user: AdminUser;
  busy: boolean;
  onRename: (fields: { displayName?: string; loginName?: string }) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(user.displayName);
  const [login, setLogin] = useState(user.loginName);

  const start = (): void => {
    // From what they are now, every time it is opened: a stale draft from a
    // cancelled edit is a rename nobody meant to make.
    setShown(user.displayName);
    setLogin(user.loginName);
    setOpen(true);
  };

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={start}>
        {copy.admin.rename}
      </button>
    );
  }

  const nextShown = shown.trim();
  const nextLogin = login.trim();
  const changed = nextShown !== user.displayName || nextLogin !== user.loginName;
  const ready = !busy && changed && nextShown !== '' && nextLogin !== '';

  return (
    <form
      className="inlineform"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        // Only what actually changed. A request that resends an unchanged login
        // is a request that can fail on the uniqueness of the name it already
        // has, which is a refusal nobody could make sense of.
        void onRename({
          ...(nextShown === user.displayName ? {} : { displayName: nextShown }),
          ...(nextLogin === user.loginName ? {} : { loginName: nextLogin }),
        }).then(() => setOpen(false));
      }}
    >
      <input
        aria-label={copy.admin.newNameFor(user.loginName)}
        placeholder={copy.admin.newNameFor(user.loginName)}
        value={shown}
        onChange={(event) => setShown(event.target.value)}
        autoComplete="off"
        required
      />
      <input
        aria-label={copy.admin.newLoginFor(user.loginName)}
        placeholder={copy.admin.newLoginFor(user.loginName)}
        value={login}
        onChange={(event) => setLogin(event.target.value)}
        autoComplete="off"
        required
      />
      <button type="submit" disabled={!ready}>
        {copy.admin.saveName}
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        {copy.admin.cancel}
      </button>
    </form>
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
