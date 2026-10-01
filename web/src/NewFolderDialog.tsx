/**
 * Making one folder, in a vault the caller may write.
 *
 * It replaces a `window.prompt`, for the reason the rename dialog already gives
 * at length: a prompt can ask for one line and nothing else, so the parent had
 * to be typed from memory and a refusal arrived afterwards, as a red line at
 * the top of the screen, about something that could have been said before
 * anything was sent.
 *
 * The prompt could also only ever make a folder in the caller's **own** vault.
 * `POST /api/v1/folders` has taken an owner and checked the share's write
 * access the whole time; the client simply never sent one, so a space had no
 * way to be given a folder at all. That is the defect this was written for, and
 * it is why the owner is a property here rather than an assumption.
 */

import { useId, useMemo, useRef, useState } from 'react';

import { ApiError } from './api';
import { copy } from './copy';
import { CloseIcon } from './icons';
import { useModalFocus } from './modal';

export interface NewFolderTarget {
  /** The vault the folder is made in. */
  owner: string;
  /** How that vault is named in the interface, or `null` for the caller's own. */
  space: string | null;
  /** The folder it goes inside, `''` for the vault's root. */
  parent: string;
}

export interface NewFolderDialogProps {
  target: NewFolderTarget;
  /** Every folder that vault already holds, so a clash is named before it is sent. */
  taken: ReadonlySet<string>;
  /** Makes the folder and refreshes the tree. Throws `ApiError` on a refusal. */
  onCreate: (owner: string, path: string) => Promise<void>;
  onClose: () => void;
}

/** The path a parent and a typed name come to, or `''` while there is no name. */
export function folderPath(parent: string, name: string): string {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  return parent === '' ? trimmed : `${parent}/${trimmed}`;
}

export function NewFolderDialog({
  target,
  taken,
  onCreate,
  onClose,
}: NewFolderDialogProps): React.JSX.Element {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useModalFocus(true, box, onClose, input);

  const path = folderPath(target.parent, name);

  /**
   * What is wrong with the name as it stands, said while it is being typed.
   *
   * A folder is not a note: there is no extension to add and no title to
   * derive, so the only rules are the vault's own. `..` is refused here as well
   * as on the server — the server's answer is the one that counts, and a path
   * that walks upwards should not have to travel to be told so.
   */
  const trouble = useMemo((): string | null => {
    if (name.trim() === '') return null;
    if (path.split('/').some((part) => part === '.' || part === '..')) return copy.newFolder.upward;
    if (path.startsWith('.') || path.includes('/.')) return copy.newFolder.dotted;
    if (taken.has(path)) return copy.newFolder.taken(path);
    return null;
  }, [name, path, taken]);

  const ready = path !== '' && trouble === null && !busy;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(target.owner, path);
      onClose();
    } catch (caught) {
      // The clash is caught above in the ordinary case; this is the one that
      // happened between the tree being read and the button being pressed.
      if (caught instanceof ApiError && caught.code === 'exists') setError(copy.newFolder.taken(path));
      else if (caught instanceof ApiError) setError(caught.message);
      else setError(copy.newFolder.failed);
      setBusy(false);
    }
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={box} className="dialog renamedlg" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="dialog-head">
          <h2 id={titleId}>
            {target.space === null ? copy.newFolder.title : copy.newFolder.titleIn(target.space)}
          </h2>
          <button
            type="button"
            className="iconbtn"
            aria-label={copy.newFolder.close}
            title={copy.newFolder.close}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <form className="renamedlg-form" onSubmit={(event) => void submit(event)}>
          <label className="renamedlg-field">
            <span>{copy.newFolder.name}</span>
            <input
              ref={input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>

          {/* Where it goes, as a sentence rather than a field: the menu was
              opened on that folder, so it is the answer and not a question. */}
          <p className="renamedlg-target">
            {copy.newFolder.inside}{' '}
            <code>{target.parent === '' ? copy.newFolder.root : target.parent}</code>
          </p>

          <p className="renamedlg-target">
            {copy.newFolder.becomes} <code>{path === '' ? copy.newFolder.noName : path}</code>
          </p>

          <p className="setnote">{copy.newFolder.slashNests}</p>

          {(trouble ?? error) !== null && (
            <p className="setbad" role="alert">
              {trouble ?? error}
            </p>
          )}

          <button type="submit" className="btn btn-solid" disabled={!ready}>
            {copy.newFolder.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
