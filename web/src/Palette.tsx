/**
 * The quick switcher: ⌘K / Ctrl-K, type, Enter.
 *
 * The single most-used control in a notes tool, so it is built for the keyboard
 * first — the mouse works, but nobody who uses this daily will reach for it.
 *
 * It searches titles and paths, never note bodies. Somebody typing `prox` to
 * jump wants the note called Proxmox, not the forty that mention it; full-text
 * search is a different question and has its own view.
 */

import { useEffect, useRef, useState } from 'react';
import { copy } from './copy';

import { api, refKey, type NoteRow } from './api';

export function Palette({
  open,
  self,
  onClose,
  onOpenNote,
}: {
  open: boolean;
  /** The signed-in account, so a hit from a shared vault can be marked as one. */
  self: string;
  onClose: () => void;
  onOpenNote: (owner: string, path: string) => void;
}): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NoteRow[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Each keystroke starts a request; a slow one must not overwrite the results of
  // a newer, faster one, so stale responses are dropped.
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const mine = ++generation.current;
    api
      .quickFind(query)
      .then(({ notes }) => {
        if (generation.current !== mine) return;
        setResults(notes);
        setActive(0);
      })
      .catch(() => {
        if (generation.current === mine) setResults([]);
      });
  }, [query, open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (note: NoteRow | undefined): void => {
    if (note === undefined) return;
    onOpenNote(note.owner, note.path);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={copy.palette.label}>
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={copy.palette.placeholder}
          aria-label={copy.palette.titleLabel}
        />

        <div className="palette-list" ref={listRef}>
          {results.length === 0 && (
            <p className="empty">{query === '' ? copy.palette.recentAppearHere : copy.palette.nothingFound}</p>
          )}

          {results.map((note, index) => (
            <button
              type="button"
              key={refKey(note.owner, note.path)}
              className="palette-item"
              data-active={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(note)}
            >
              <span className="t">{note.title}</span>
              <span className="p">
                {/* Two vaults can hold the same title, so a hit that is not yours
                    has to say so — otherwise the switcher offers two identical
                    rows and picking is a coin toss. */}
                {note.owner !== self && <span className="pill p-info">{note.owner}</span>}
                {note.path.split('/').slice(0, -1).join('/') || '/'}
              </span>
            </button>
          ))}
        </div>

        <div className="palette-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd> {copy.palette.choose} · <kbd>⏎</kbd> {copy.palette.open} · <kbd>Esc</kbd> {copy.palette.close}
        </div>
      </div>
    </div>
  );
}
