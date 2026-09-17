/**
 * Sharing one note.
 *
 * Opened from the note's header, the inspector and the tree, and only on a note
 * the caller may share at all (`rights.mayShare`): your own, or, as an
 * administrator, one in a space. The two go to different doors on the server —
 * your own shares for your own note, the space's member list for a space's —
 * and this dialog hides that difference, because to the person using it both
 * are "let Anna read this note".
 *
 * It shows what already reaches the note, in two groups. Shares of this very
 * note can be withdrawn here. Shares of a folder or the whole vault that happen
 * to include it are listed too, without a button: withdrawing one of those takes
 * away far more than this note, and that belongs on the page that says so.
 *
 * A note share names one file. It follows the note when ndBrain renames or moves
 * it, and it never passes to a different note that later takes the same name —
 * which is what the line under the form tells the person before they click.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { ApiError, api, type OwnerKind, type Share, type User } from './api';
import { copy } from './copy';
import { CloseIcon, FileIcon, FolderIcon, VaultIcon } from './icons';
import { keys } from './queries';
import { covers } from './rights';

export interface ShareTarget {
  owner: string;
  path: string;
  title: string;
}

export interface ShareDialogProps {
  note: ShareTarget;
  user: Pick<User, 'id' | 'role'>;
  /** What kind of vault the note is in; a space's note is shared through its members. */
  ownerKind: OwnerKind;
  /** The space's display name, or the owner's account name. */
  ownerLabel: string;
  /** The caller's own outgoing shares, from `/shares`. Read for a note of their own. */
  granted: readonly Share[];
  /** Account names worth suggesting. Typing any other name works as well. */
  people: readonly string[];
  /** Called after a grant or a withdrawal, once the lists have been marked stale. */
  onChanged?: () => void;
  onClose: () => void;
}

/** The icon for what a share opens: a vault, a folder, one note. */
export function ShareKindIcon({ kind, size = 15 }: { kind: Share['kind']; size?: number }): React.JSX.Element {
  if (kind === 'vault') return <VaultIcon size={size} />;
  if (kind === 'folder') return <FolderIcon size={size} />;
  return <FileIcon size={size} />;
}

export function ShareDialog({
  note,
  user,
  ownerKind,
  ownerLabel,
  granted,
  people,
  onChanged,
  onClose,
}: ShareDialogProps): React.JSX.Element {
  const client = useQueryClient();
  const inSpace = ownerKind === 'space' && note.owner !== user.id;
  const titleId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  const [grantee, setGrantee] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: keys.spaceMembers(note.owner),
    queryFn: () => api.spaceMembers(note.owner),
    enabled: inSpace,
    staleTime: 5_000,
    retry: false,
  });

  const all: readonly Share[] = inSpace ? (members.data ?? []) : granted.filter((share) => share.owner === note.owner);
  const exact = useMemo(
    () => all.filter((share) => share.kind === 'note' && share.prefix === note.path),
    [all, note.path],
  );
  const wider = useMemo(
    () => all.filter((share) => share.kind !== 'note' && covers(share, note.path)),
    [all, note.path],
  );

  useEffect(() => {
    input.current?.focus();
  }, []);

  const refresh = async (): Promise<void> => {
    if (inSpace) {
      await client.invalidateQueries({ queryKey: keys.spaceMembers(note.owner) });
      await client.invalidateQueries({ queryKey: keys.adminSpaces });
    } else {
      await client.invalidateQueries({ queryKey: keys.shares });
    }
    onChanged?.();
  };

  const run = async (work: () => Promise<unknown>, failed: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : failed);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const name = grantee.trim();
    if (name === '' || busy) return;
    const done = await run(
      () =>
        inSpace
          ? api.addSpaceMember(note.owner, name, 'note', note.path, canWrite)
          : api.grantShare(name, 'note', note.path, canWrite),
      copy.shareNote.grantFailed,
    );
    if (done) {
      setGrantee('');
      setCanWrite(false);
    }
  };

  const withdraw = async (share: Share): Promise<void> => {
    if (!window.confirm(copy.shareNote.confirmWithdraw(share.grantee, note.title))) return;
    await run(
      () => (inSpace ? api.removeSpaceMember(note.owner, share.id) : api.revokeShare(share.id)),
      copy.shareNote.withdrawFailed,
    );
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog sharedlg" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <header className="dialog-head">
          <h2 id={titleId}>{copy.shareNote.title(note.title)}</h2>
          <button type="button" className="iconbtn" aria-label={copy.shareNote.close} title={copy.shareNote.close} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </header>
        <p className="dialog-sub">
          {inSpace ? copy.shareNote.inSpace(ownerLabel) : copy.shareNote.yours} · <code>{note.path}</code>
        </p>

        <form className="sharedlg-form" onSubmit={(event) => void submit(event)}>
          <label className="sharedlg-person">
            <span>{copy.shareNote.person}</span>
            <input
              ref={input}
              value={grantee}
              onChange={(event) => setGrantee(event.target.value)}
              placeholder={copy.shareNote.personPlaceholder}
              list={listId}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <datalist id={listId}>
              {people.map((name) => (
                <option value={name} key={name} />
              ))}
            </datalist>
          </label>

          <fieldset className="sharedlg-right">
            <legend>{copy.shareNote.right}</legend>
            <label>
              <input type="radio" name="right" checked={!canWrite} onChange={() => setCanWrite(false)} />
              <span>{copy.shareNote.read}</span>
            </label>
            <label>
              <input type="radio" name="right" checked={canWrite} onChange={() => setCanWrite(true)} />
              <span>{copy.shareNote.write}</span>
            </label>
          </fieldset>

          <button type="submit" className="btn btn-solid" disabled={busy || grantee.trim() === ''}>
            {copy.shareNote.share}
          </button>
        </form>
        <p className="setnote">{copy.shareNote.follows}</p>

        {error !== null && (
          <p className="setbad" role="alert">
            {error}
          </p>
        )}

        <section className="sharedlg-list" aria-label={copy.shareNote.existing}>
          <h3 className="cap">{copy.shareNote.existing}</h3>
          {inSpace && members.isPending ? (
            <p className="empty">{copy.shareNote.loading}</p>
          ) : exact.length === 0 ? (
            <p className="empty">{copy.shareNote.none}</p>
          ) : (
            <ul>
              {exact.map((share) => (
                <li key={share.id}>
                  <span className="nm">{share.grantee}</span>
                  <span className="pill p-tag">{share.canWrite ? copy.shares.readWrite : copy.shares.readOnly}</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    aria-label={copy.shareNote.withdrawLabel(share.grantee)}
                    onClick={() => void withdraw(share)}
                  >
                    {copy.shares.withdraw}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {wider.length > 0 && (
            <>
              <h3 className="cap">{copy.shareNote.wider}</h3>
              <ul>
                {wider.map((share) => (
                  <li key={share.id}>
                    <span className="nm">{share.grantee}</span>
                    <span className="sharedlg-where">
                      <ShareKindIcon kind={share.kind} size={14} />
                      {share.kind === 'vault' ? copy.shares.wholeVault : share.prefix}
                    </span>
                    <span className="pill p-tag">{share.canWrite ? copy.shares.readWrite : copy.shares.readOnly}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
