/**
 * Spaces, in the administration.
 *
 * A space is a vault several people keep together — a family's lists, a club's
 * minutes — that nobody signs in to. The administrator creates it, names it, and
 * decides who sees what in it: the whole space, one folder, or a single note,
 * each read-only or writable. Members find it as its own root in their tree.
 *
 * Built like the rest of this screen: slow where a mistake is expensive. The
 * account name becomes the space's folder on disk and can never change, so the
 * form says that, and the naming rule, before anything is submitted — not in an
 * error after. Disabling asks first. Withdrawing a member asks first.
 *
 * A member is an ordinary share whose owner is the space, so the table here
 * reads exactly like the sharing page: who, what (with the same icons), and
 * which right.
 */

import { useMemo, useState } from 'react';

import { ApiError, type AdminSpace, type AdminUser, type Share, type ShareKind } from './api';
import { copy } from './copy';
import { SpaceIcon } from './icons';
import { useSpaceMembers, useSpaceTree } from './queries';
import { ShareKindIcon } from './ShareDialog';

/** The server's account-name rule (`USER_ID_RE`), stated once for the form. */
export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface AdminSpacesProps {
  spaces: AdminSpace[];
  /** Every account, for the name clash check and the member picker. */
  users: AdminUser[];
  busy: boolean;
  onCreate: (id: string, displayName: string) => Promise<void>;
  onRename: (id: string, displayName: string) => Promise<void>;
  onSetDisabled: (id: string, disabled: boolean) => Promise<void>;
  onAddMember: (space: string, grantee: string, kind: ShareKind, path: string, canWrite: boolean) => Promise<void>;
  onRemoveMember: (space: string, share: Share) => Promise<void>;
}

/**
 * What the member picker offers from a space's tree: every note, and every
 * folder — the ones the tree lists, which include empty ones, and the ones on
 * the way to a note, so a folder is offered even if a listing ever left it out.
 */
export function spaceChoices(tree: { dirs: string[]; notes: Array<{ path: string }> }): {
  folders: string[];
  notes: string[];
} {
  const folders = new Set(tree.dirs);
  for (const note of tree.notes) {
    const segments = note.path.split('/').slice(0, -1);
    for (let i = 1; i <= segments.length; i += 1) folders.add(segments.slice(0, i).join('/'));
  }
  const byPath = (a: string, b: string): number => a.localeCompare(b);
  return {
    folders: [...folders].sort(byPath),
    notes: tree.notes.map((note) => note.path).sort(byPath),
  };
}

/** Why a proposed account name cannot be used, or null when it can. */
export function spaceNameProblem(id: string, taken: ReadonlySet<string>): string | null {
  if (id === '') return null;
  if (id.length > 64 || !ACCOUNT_NAME.test(id)) return copy.spaces.nameInvalid;
  if ([...taken].some((name) => name.toLowerCase() === id.toLowerCase())) return copy.spaces.nameTaken(id);
  return null;
}

export function AdminSpaces(props: AdminSpacesProps): React.JSX.Element {
  const { spaces, users, busy } = props;
  const [status, setStatus] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const guard = async (run: () => Promise<void>, ok: string): Promise<boolean> => {
    try {
      await run();
      setStatus({ kind: 'ok', text: ok });
      return true;
    } catch (caught) {
      setStatus({ kind: 'bad', text: caught instanceof ApiError ? caught.message : copy.admin.failed });
      return false;
    }
  };

  const taken = useMemo(
    () => new Set([...users.map((user) => user.id), ...spaces.map((space) => space.id)]),
    [users, spaces],
  );
  const managed = spaces.find((space) => space.id === managing) ?? null;

  return (
    <section className="setgroup spaces" aria-labelledby="admin-spaces">
      <h3 className="cap" id="admin-spaces">
        {copy.spaces.title}
      </h3>
      <p className="setnote">{copy.spaces.explain}</p>

      {/* The region, not the line: a `role="status"` mounted together with its
          one message has nothing to change and is never announced. */}
      <div role="status">
        {status !== null && <p className={status.kind === 'ok' ? 'setok' : 'setbad'}>{status.text}</p>}
      </div>

      {spaces.length === 0 ? (
        <p className="empty">{copy.spaces.none}</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>{copy.spaces.name}</th>
              <th className="n">{copy.admin.notes}</th>
              <th className="n">{copy.spaces.members}</th>
              <th className="n">{copy.admin.actions}</th>
            </tr>
          </thead>
          <tbody>
            {spaces.map((space) => (
              <tr key={space.id} data-disabled={space.disabled}>
                <td>
                  <SpaceIcon size={14} className="vault-icon" />{' '}
                  {renaming === space.id ? (
                    <RenameSpace
                      space={space}
                      busy={busy}
                      onCancel={() => setRenaming(null)}
                      onRename={async (name) => {
                        if (await guard(() => props.onRename(space.id, name), copy.spaces.renamed(name))) setRenaming(null);
                      }}
                    />
                  ) : (
                    <>
                      <span className="adminname">{space.displayName}</span>
                      <span className="adminid">{space.id}</span>
                    </>
                  )}
                  {space.disabled && <span className="pill p-crit">{copy.admin.disabled}</span>}
                </td>
                <td className="n">{space.noteCount}</td>
                <td className="n">{space.members}</td>
                <td className="n adminrow-actions">
                  <button
                    type="button"
                    aria-expanded={managing === space.id}
                    aria-label={copy.spaces.manageLabel(space.displayName)}
                    onClick={() => setManaging((current) => (current === space.id ? null : space.id))}
                  >
                    {copy.spaces.manage}
                  </button>
                  {renaming !== space.id && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={copy.spaces.renameLabel(space.displayName)}
                      onClick={() => setRenaming(space.id)}
                    >
                      {copy.spaces.rename}
                    </button>
                  )}
                  <button
                    type="button"
                    className={space.disabled ? '' : 'danger'}
                    disabled={busy}
                    aria-label={
                      space.disabled
                        ? copy.spaces.enableLabel(space.displayName)
                        : copy.spaces.disableLabel(space.displayName)
                    }
                    onClick={() => {
                      if (!space.disabled && !window.confirm(copy.spaces.confirmDisable(space.displayName))) return;
                      void guard(
                        () => props.onSetDisabled(space.id, !space.disabled),
                        space.disabled ? copy.spaces.enabled(space.displayName) : copy.spaces.disabledNow(space.displayName),
                      );
                    }}
                  >
                    {space.disabled ? copy.admin.enable : copy.admin.disable}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {managed !== null && (
        <Members
          key={managed.id}
          space={managed}
          users={users.filter((user) => !spaces.some((space) => space.id === user.id))}
          busy={busy}
          onAdd={(grantee, kind, path, canWrite) =>
            guard(
              () => props.onAddMember(managed.id, grantee, kind, path, canWrite),
              copy.spaces.memberAdded(grantee, managed.displayName),
            )
          }
          onRemove={(share) => {
            if (!window.confirm(copy.spaces.confirmRemove(share.grantee, managed.displayName))) return;
            void guard(() => props.onRemoveMember(managed.id, share), copy.spaces.memberRemoved(share.grantee));
          }}
        />
      )}

      <NewSpace
        busy={busy}
        taken={taken}
        onCreate={(id, displayName) => guard(() => props.onCreate(id, displayName), copy.spaces.created(displayName))}
      />
    </section>
  );
}

function RenameSpace({
  space,
  busy,
  onRename,
  onCancel,
}: {
  space: AdminSpace;
  busy: boolean;
  onRename: (displayName: string) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(space.displayName);
  return (
    <form
      className="inlineform spaces-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() === '') return;
        void onRename(value.trim());
      }}
    >
      <input
        value={value}
        maxLength={64}
        aria-label={copy.spaces.displayNameFor(space.id)}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" disabled={busy || value.trim() === '' || value.trim() === space.displayName}>
        {copy.admin.set}
      </button>
      <button type="button" onClick={onCancel}>
        {copy.admin.cancel}
      </button>
    </form>
  );
}

function NewSpace({
  busy,
  taken,
  onCreate,
}: {
  busy: boolean;
  taken: ReadonlySet<string>;
  onCreate: (id: string, displayName: string) => Promise<boolean>;
}): React.JSX.Element {
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const problem = spaceNameProblem(id.trim(), taken);

  return (
    <form
      className="adminform spaces-form"
      onSubmit={(event) => {
        event.preventDefault();
        const name = id.trim();
        if (name === '' || problem !== null) return;
        void onCreate(name, displayName.trim() || name).then((done) => {
          if (!done) return;
          setId('');
          setDisplayName('');
        });
      }}
    >
      <h4>{copy.spaces.newSpace}</h4>
      {/* Both said before the first keystroke: what a legal name is, and that
          this one is for good. An error after submitting teaches the rule one
          failure at a time. */}
      <p className="setnote" id="space-name-rule">
        {copy.spaces.nameRule}
      </p>
      <p className="setnote">{copy.spaces.idIsPermanent}</p>

      <label>
        <span>{copy.spaces.accountName}</span>
        <input
          value={id}
          maxLength={64}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="space-name-rule"
          aria-invalid={problem !== null}
          onChange={(event) => setId(event.target.value)}
          required
        />
      </label>
      {problem !== null && (
        <p className="setbad" role="alert">
          {problem}
        </p>
      )}
      <label>
        <span>{copy.admin.displayName}</span>
        <input
          value={displayName}
          maxLength={64}
          placeholder={id}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>

      <button type="submit" disabled={busy || id.trim() === '' || problem !== null}>
        {copy.spaces.create}
      </button>
    </form>
  );
}

/** How much of the space a member gets: the whole of it, a folder, or one note. */
type Extent = ShareKind;

function Members({
  space,
  users,
  busy,
  onAdd,
  onRemove,
}: {
  space: AdminSpace;
  users: AdminUser[];
  busy: boolean;
  onAdd: (grantee: string, kind: ShareKind, path: string, canWrite: boolean) => Promise<boolean>;
  onRemove: (share: Share) => void;
}): React.JSX.Element {
  const members = useSpaceMembers(space.id);
  // The space's own tree, from the admin-only route: the administrator picks a
  // folder or a note without having to be a member of the space first.
  const tree = useSpaceTree(space.id);
  const paths = useMemo(() => (tree.data === undefined ? null : spaceChoices(tree.data)), [tree.data]);
  const people = users.filter((user) => !user.disabled);
  const [grantee, setGrantee] = useState('');
  const [extent, setExtent] = useState<Extent>('vault');
  const [path, setPath] = useState('');
  const [canWrite, setCanWrite] = useState(false);

  const choices = paths === null ? [] : extent === 'folder' ? paths.folders : extent === 'note' ? paths.notes : [];
  const ready = grantee !== '' && (extent === 'vault' || path.trim() !== '');

  return (
    <div className="members" aria-label={copy.spaces.membersOf(space.displayName)} role="region">
      <h4>{copy.spaces.membersOf(space.displayName)}</h4>

      {members.isPending ? (
        <p className="empty">{copy.shareNote.loading}</p>
      ) : members.isError ? (
        <p className="setbad">{copy.spaces.membersFailed}</p>
      ) : members.data.length === 0 ? (
        <p className="empty">{copy.spaces.noMembers}</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>{copy.shareNote.person}</th>
              <th>{copy.shares.what}</th>
              <th>{copy.shareNote.right}</th>
              <th className="n">{copy.admin.actions}</th>
            </tr>
          </thead>
          <tbody>
            {members.data.map((share) => (
              <tr key={share.id}>
                <td className="nm">{share.grantee}</td>
                <td className="pth">
                  <span className="share-kind" data-kind={share.kind}>
                    <ShareKindIcon kind={share.kind} size={14} />
                    <span className="share-kind-word">{copy.spaces.extent[share.kind]}</span>
                  </span>
                  {share.kind === 'vault' ? '' : share.prefix}
                </td>
                <td>
                  <span className="pill p-tag">{share.canWrite ? copy.shares.readWrite : copy.shares.readOnly}</span>
                </td>
                <td className="n adminrow-actions">
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    aria-label={copy.spaces.removeLabel(share.grantee)}
                    onClick={() => onRemove(share)}
                  >
                    {copy.shares.withdraw}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form
        className="adminform members-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          void onAdd(grantee, extent, extent === 'vault' ? '' : path.trim(), canWrite).then((done) => {
            if (!done) return;
            setGrantee('');
            setPath('');
            setCanWrite(false);
          });
        }}
      >
        <h4>{copy.spaces.addMember}</h4>
        <label>
          <span>{copy.shareNote.person}</span>
          <select value={grantee} onChange={(event) => setGrantee(event.target.value)} required>
            <option value="">{copy.spaces.pickPerson}</option>
            {people.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName} ({user.id})
              </option>
            ))}
          </select>
        </label>

        <fieldset className="sharedlg-right">
          <legend>{copy.spaces.extentLabel}</legend>
          {(['vault', 'folder', 'note'] as const).map((kind) => (
            <label key={kind}>
              <input
                type="radio"
                name={`extent-${space.id}`}
                checked={extent === kind}
                onChange={() => {
                  setExtent(kind);
                  setPath('');
                }}
              />
              <ShareKindIcon kind={kind} size={14} />
              <span>{copy.spaces.extent[kind]}</span>
            </label>
          ))}
        </fieldset>

        {extent !== 'vault' && (
          <label>
            <span>{extent === 'folder' ? copy.spaces.pickFolder : copy.spaces.pickNote}</span>
            {tree.isPending ? (
              <span className="setnote">{copy.spaces.loadingTree}</span>
            ) : paths === null ? (
              // The tree could not be read: a typed path still works, and the
              // server refuses one that does not name a folder or note of the space.
              <>
                <input
                  value={path}
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={extent === 'folder' ? copy.spaces.folderExample : copy.spaces.noteExample}
                  onChange={(event) => setPath(event.target.value)}
                  required
                />
                <span className="setnote">{copy.spaces.notVisible}</span>
              </>
            ) : choices.length === 0 ? (
              <span className="setnote">{copy.spaces.nothingToPick[extent]}</span>
            ) : (
              <select value={path} onChange={(event) => setPath(event.target.value)} required>
                <option value="">{copy.spaces.choose}</option>
                {choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        <fieldset className="sharedlg-right">
          <legend>{copy.shareNote.right}</legend>
          <label>
            <input type="radio" name={`right-${space.id}`} checked={!canWrite} onChange={() => setCanWrite(false)} />
            <span>{copy.shareNote.read}</span>
          </label>
          <label>
            <input type="radio" name={`right-${space.id}`} checked={canWrite} onChange={() => setCanWrite(true)} />
            <span>{copy.shareNote.write}</span>
          </label>
        </fieldset>

        <button type="submit" disabled={busy || !ready}>
          {copy.spaces.add}
        </button>
      </form>
    </div>
  );
}
