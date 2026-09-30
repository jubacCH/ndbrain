/**
 * Starting a note.
 *
 * The first thing this product ever asks anybody, and for a long time it asked
 * with `window.prompt`. Behind the tree's own first-run invitation — "Start
 * your first note", with a sentence about how links build the map — a new
 * account got an unstyled system box in the operating system's typeface, with
 * no theme, no validation, no folder, and one line of instruction about typing
 * a slash. It was the one interaction in the application that looked like it
 * belonged to another program, at the one moment nothing had been earned yet.
 *
 * `RenameDialog.tsx` had already worked out what the answer looks like, and
 * this is deliberately its mirror image: the folder is *picked* from the
 * vault's own folders rather than typed from memory, the path that will be
 * written is shown before anything is written, and the name and the folder are
 * two fields because they are two decisions.
 *
 * Three things are said here that the prompt could only have found out from a
 * refusal, all three being rules the server keeps anyway:
 *
 *  - a name holding `[`, `]`, `|` or `#` is a note no `[[wikilink]]` can point
 *    at, which in a tool built on links is a trap rather than a preference —
 *    `assertLinkableName` in `server/src/vault/paths.ts`, found the hard way
 *    when 27 of 58 imported notes were named that way
 *  - a path already taken; the prompt sent it and reported the clash afterwards
 *  - a shape the vault cannot hold: absolute, dotted, or stepping upwards
 *
 * The slash survives. It was the prompt's one instruction and it still works,
 * because the folder list can only offer folders that exist and people do start
 * notes in folders that do not — so it stayed, and now says which folder it is
 * about to bring into being. It is also the only way the typed half could reach
 * out of the folder that was picked, which is why `..` is refused rather than
 * quietly normalised: the picked folder is what guarantees the note lands
 * somewhere the caller may write.
 */

import { useId, useMemo, useRef, useState } from 'react';

import { ApiError } from './api';
import { copy } from './copy';
import { CloseIcon } from './icons';
import { useModalFocus } from './modal';

export interface NewNoteTarget {
  /** The vault the note is started in. */
  owner: string;
  /**
   * How that vault is named in the interface, or `null` for the caller's own.
   *
   * Your own vault needs no naming — every other note you start is in it — and
   * a heading that named it would be the only place in the application that
   * calls it anything.
   */
  space: string | null;
}

export interface NewNoteDialogProps {
  target: NewNoteTarget;
  /**
   * The folders the note may be started in, `''` meaning the root of that
   * vault. Which of them those are is the shell's decision — in a space, only
   * the part that was shared with write access.
   */
  folders: readonly string[];
  /** The paths that vault already holds, so a clash is named before it is sent. */
  taken: ReadonlySet<string>;
  /**
   * Writes the note and opens it. Throws `ApiError` on a refusal; the dialog
   * stays open on one, because a name the server would not take is something
   * to correct here rather than a reason to start again.
   */
  onCreate: (path: string) => Promise<void>;
  onClose: () => void;
}

/** The characters `markdown/parse.ts` cannot match inside a `[[wikilink]]`. */
const UNLINKABLE = /[[\]|#]/;

/**
 * The path a folder and a typed name come to, or `''` while there is no name.
 *
 * The extension is added here rather than left to the caller so that what the
 * dialog shows and what it sends are the same string. A name that already ends
 * in `.md` is left alone: somebody typing the file name is not asking for
 * `Plan.md.md`.
 */
export function newNotePath(folder: string, name: string): string {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  const file = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  return folder === '' ? file : `${folder}/${file}`;
}

/**
 * Why this name cannot be used, or `null` when it can.
 *
 * Each of these is the server's own rule, checked against the *typed* name
 * rather than the whole path: the folder came from a list and is not the
 * caller's mistake to be told about.
 */
export function nameTrouble(name: string, folder: string, taken: ReadonlySet<string>): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;

  const segments = trimmed.split('/');
  const file = segments[segments.length - 1]!;
  if (UNLINKABLE.test(file.replace(/\.md$/i, ''))) return copy.newNote.unlinkable;

  // An absolute path, an upward step, or a segment beginning with a dot. The
  // last is the one with teeth: a dotted entry is invisible to every listing
  // this vault does and to the watcher, `.git` included.
  if (trimmed.startsWith('/') || segments.some((one) => one === '..' || one.startsWith('.'))) {
    return copy.newNote.badPath;
  }

  const path = newNotePath(folder, trimmed);
  if (taken.has(path)) return copy.newNote.taken(path);
  return null;
}

/**
 * The folders to offer, in the order they are offered.
 *
 * The vault's root first where it is one of them — it is not a folder among
 * the others, it is the absence of one — and the rest by name. Duplicates are
 * dropped rather than trusted away: the list is assembled from the notes and
 * from the tree's own folder rows, which overlap.
 */
export function folderOptions(folders: readonly string[]): string[] {
  const all = [...new Set(folders)];
  const rest = all.filter((one) => one !== '').sort((a, b) => a.localeCompare(b));
  return all.includes('') ? ['', ...rest] : rest;
}

/** The folder a slash in the name brings into being, or `null` when it does not. */
export function nestedFolder(folder: string, name: string): string | null {
  const segments = name.trim().split('/');
  segments.pop();
  const below = segments.filter((one) => one !== '').join('/');
  if (below === '') return null;
  return folder === '' ? below : `${folder}/${below}`;
}

export function NewNoteDialog({
  target,
  folders,
  taken,
  onCreate,
  onClose,
}: NewNoteDialogProps): React.JSX.Element {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const options = useMemo(() => folderOptions(folders), [folders]);

  const [name, setName] = useState('');
  // Whatever is offered first, so the select's value is never one of its
  // options by accident — a select showing a folder it is not set to would
  // put the note somewhere else on the first submit.
  const [folder, setFolder] = useState(() => folderOptions(folders)[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Always open, because the dialog is only ever mounted while it is.
  useModalFocus(true, box, onClose, input);

  const trouble = nameTrouble(name, folder, taken);
  const path = newNotePath(folder, name);
  const makes = trouble === null ? nestedFolder(folder, name) : null;
  const ready = path !== '' && trouble === null && !busy;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(path);
      onClose();
    } catch (caught) {
      // The clash is caught above in the ordinary case; this is the one that
      // happened between the tree being read and the button being pressed.
      if (caught instanceof ApiError && caught.code === 'exists') setError(copy.newNote.taken(path));
      else if (caught instanceof ApiError) setError(caught.message);
      else setError(copy.newNote.failed);
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
            {target.space === null ? copy.newNote.title : copy.newNote.titleIn(target.space)}
          </h2>
          <button
            type="button"
            className="iconbtn"
            aria-label={copy.newNote.close}
            title={copy.newNote.close}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <form className="renamedlg-form" onSubmit={(event) => void submit(event)}>
          <label className="renamedlg-field">
            <span>{copy.newNote.name}</span>
            <input
              ref={input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>

          {/* Drawn even where it holds one folder. In a space that is the whole
              answer to "where may I write?", and hiding it would leave the
              path line below as the only place that says so. */}
          <label className="renamedlg-field">
            <span>{copy.newNote.folder}</span>
            <select value={folder} onChange={(event) => setFolder(event.target.value)}>
              {options.map((one) => (
                <option value={one} key={one === '' ? ' root' : one}>
                  {one === '' ? copy.newNote.root : one}
                </option>
              ))}
            </select>
          </label>

          {/* What will actually be written, before it is — the same promise the
              rename dialog makes in the other direction. */}
          <p className="renamedlg-target">
            {copy.newNote.becomes} <code>{path === '' ? copy.newNote.noName : path}</code>
          </p>

          <p className="setnote">{makes !== null ? copy.newNote.makesFolder(makes) : copy.newNote.slashNests}</p>

          {(trouble ?? error) !== null && (
            <p className="setbad" role="alert">
              {trouble ?? error}
            </p>
          )}

          <button type="submit" className="btn btn-solid" disabled={!ready}>
            {copy.newNote.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
