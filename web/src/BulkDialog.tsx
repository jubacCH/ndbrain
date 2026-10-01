/**
 * The two questions a bulk action asks, as a dialog rather than a prompt.
 *
 * They were the last `window.prompt`s on this path, and inherited rather than
 * chosen — the hook's own docstring said so and said why it had not been done.
 * What a prompt costs here is specific, not stylistic:
 *
 *  - **Moving.** The destination had to be typed from memory, with `Archive`
 *    offered as a default whether or not the vault had one. A folder that does
 *    not exist is made by the move, so a typo quietly created `Archiv` beside
 *    `Archive` and put forty notes in it. The vault's own folders are offered
 *    as suggestions now — and it stays a field rather than becoming a list,
 *    because naming a folder that is not there yet is the move's own feature
 *    and a picker would have taken it away.
 *  - **Tagging.** `markdown/parse.ts` reads a tag as `#` and a letter followed
 *    by letters, digits, `_`, `/` or `-`. A tag that breaks that is written
 *    into forty notes and then matches nothing — the notes are changed, the
 *    operation reports success, and the tag does not exist as far as search is
 *    concerned. The rule is checked here, where there is somewhere to say it.
 *
 * Deleting keeps its `window.confirm`: it asks a yes-or-no question and takes
 * no input, and what it needed — what will be lost — it already says.
 */

import { useId, useMemo, useRef, useState } from 'react';

import { copy } from './copy';
import { CloseIcon } from './icons';
import { useModalFocus } from './modal';

export interface BulkAsk {
  kind: 'move' | 'tag';
  /** How many notes it will touch, which is the thing worth repeating. */
  count: number;
}

/** What `markdown/parse.ts` will read back as a tag, and nothing else. */
const TAG_OK = /^\p{L}[\p{L}\p{N}_/-]*$/u;

export function BulkDialog({
  ask,
  folders,
  tags,
  onApply,
  onClose,
}: {
  ask: BulkAsk;
  /** The vault's folders, `''` meaning its top. Only used for a move. */
  folders: readonly string[];
  /** The tags already in use, offered as suggestions rather than as a limit. */
  tags: readonly string[];
  onApply: (extra: { dir?: string; tag?: string }) => void;
  onClose: () => void;
}): React.JSX.Element {
  const titleId = useId();
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLElement>(null);

  // The top of the vault is a legitimate destination and is the one a prompt
  // expressed as "empty", which nobody could have guessed.
  const [dir, setDir] = useState('');
  const [tag, setTag] = useState('');

  useModalFocus(true, box, onClose, first);

  const trouble = useMemo((): string | null => {
    if (ask.kind === 'tag') {
      const value = tag.trim().replace(/^#/, '');
      if (value === '') return null;
      return TAG_OK.test(value) ? null : copy.bulk.tagShape;
    }

    // The same two rules the server's `normalizeVaultPath` enforces, said here
    // rather than after forty notes have been sent somewhere it refuses.
    const where = dir.trim().replace(/^\/+|\/+$/g, '');
    if (where === '') return null;
    if (where.split('/').some((part) => part === '.' || part === '..')) return copy.bulk.upward;
    if (where.startsWith('.') || where.includes('/.')) return copy.bulk.dotted;
    return null;
  }, [ask.kind, tag, dir]);

  const ready =
    trouble === null && (ask.kind === 'move' || tag.trim().replace(/^#/, '') !== '');

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    // The hash is the way a tag is written and not part of its name; stripped
    // here so that typing it or leaving it out come to the same thing.
    onApply(
      ask.kind === 'move'
        ? { dir: dir.trim().replace(/^\/+|\/+$/g, '') }
        : { tag: tag.trim().replace(/^#/, '') },
    );
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
            {ask.kind === 'move' ? copy.bulk.moveTitle(ask.count) : copy.bulk.tagTitle(ask.count)}
          </h2>
          <button type="button" className="iconbtn" aria-label={copy.bulk.close} title={copy.bulk.close} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </header>

        <form className="renamedlg-form" onSubmit={submit}>
          {ask.kind === 'move' ? (
            <label className="renamedlg-field">
              <span>{copy.bulk.folder}</span>
              <input
                ref={first as React.RefObject<HTMLInputElement>}
                value={dir}
                onChange={(event) => setDir(event.target.value)}
                list={listId}
                placeholder={copy.bulk.root}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <datalist id={listId}>
                {folders.filter((one) => one !== '').map((one) => (
                  <option value={one} key={one} />
                ))}
              </datalist>
            </label>
          ) : (
            <label className="renamedlg-field">
              <span>{copy.bulk.tag}</span>
              <input
                ref={first as React.RefObject<HTMLInputElement>}
                value={tag}
                onChange={(event) => setTag(event.target.value)}
                list={listId}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {/* Suggestions, not a list to choose from: a new tag is the
                  ordinary case and must stay one keystroke, not a mode. */}
              <datalist id={listId}>
                {tags.map((one) => (
                  <option value={one} key={one} />
                ))}
              </datalist>
            </label>
          )}

          <p className="setnote">{ask.kind === 'move' ? copy.bulk.movesMake : copy.bulk.tagRule}</p>

          {trouble !== null && (
            <p className="setbad" role="alert">
              {trouble}
            </p>
          )}

          <button type="submit" className="btn btn-solid" disabled={!ready}>
            {ask.kind === 'move' ? copy.bulk.move : copy.bulk.apply}
          </button>
        </form>
      </div>
    </div>
  );
}
