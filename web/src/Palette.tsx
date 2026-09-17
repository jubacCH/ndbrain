/**
 * The quick switcher: ⌘K / Ctrl-K, type, Enter.
 *
 * The single most-used control in a notes tool, so it is built for the keyboard
 * first — the mouse works, but nobody who uses this daily will reach for it.
 *
 * Two questions in one list, in the order people mean them. Somebody typing
 * `prox` to jump wants the note called Proxmox first, so notes found by title
 * and path come at once and stay on top. Below them, "In notes" answers the
 * other question — which notes mention it — from the same full-text search the
 * Search view uses, with the matched words in an excerpt. That half waits for a
 * pause in typing, so a word typed at speed costs one request rather than one per
 * key, and an answer that arrives late for a query already replaced is dropped.
 * The last row hands the words to the Search view, where filters live.
 */

import { useEffect, useRef, useState } from 'react';
import { copy } from './copy';

import { api, refKey, type NoteRow, type SearchHit } from './api';
import { snippetParts } from './snippet';

/**
 * How long typing has to pause before the full-text half is asked.
 *
 * Long enough that a word typed at normal speed is one request, short enough
 * that the hits are there by the time the eyes have moved down to them.
 */
export const TEXT_SEARCH_DELAY_MS = 180;

/** Below this many characters, nearly every note matches and the hits say nothing. */
export const TEXT_SEARCH_MIN_LENGTH = 2;

/** More than this is a job for the Search view, which the last row opens. */
const TEXT_HITS_SHOWN = 8;

/**
 * Something the palette can do besides opening a note by name.
 *
 * Few and listed above the notes, filtered by the same words the person types:
 * a command is found by its label or its keywords, so "today" reaches today's
 * note before the notes that happen to have the word in their title.
 */
export interface PaletteCommand {
  key: string;
  label: string;
  /** Extra words it is found by, space separated. */
  keywords?: string;
  /** A shortcut shown beside it. */
  shortcut?: string;
  run: () => void;
}

/** Where in a note a full-text hit was, for the editor to scroll to. */
export interface PaletteFind {
  snippet: string;
  query: string;
}

/** The commands that match what is typed; all of them when nothing is. */
export function matchCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...commands];
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.keywords ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

type Row =
  | { kind: 'command'; command: PaletteCommand }
  | { kind: 'note'; note: NoteRow }
  | { kind: 'text'; hit: SearchHit }
  | { kind: 'searchAll'; query: string };

export function Palette({
  open,
  self,
  commands = [],
  onClose,
  onOpenNote,
  onSearchAll,
}: {
  open: boolean;
  /** The signed-in account, so a hit from a shared vault can be marked as one. */
  self: string;
  commands?: readonly PaletteCommand[];
  onClose: () => void;
  /** `find` is set for a full-text hit, so the note can open where the words are. */
  onOpenNote: (owner: string, path: string, find?: PaletteFind) => void;
  /** Opens the Search view on these words. */
  onSearchAll?: (query: string) => void;
}): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NoteRow[]>([]);
  const [textHits, setTextHits] = useState<{ query: string; hits: SearchHit[] }>({ query: '', hits: [] });
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Each keystroke starts a request; a slow one must not overwrite the results of
  // a newer, faster one, so stale responses are dropped.
  const generation = useRef(0);
  // The same for the full-text half, counted apart: its requests are fewer and
  // later, and one must not be dropped because a title lookup overtook it.
  const textGeneration = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setTextHits({ query: '', hits: [] });
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

  useEffect(() => {
    // Every change of the words, and closing, makes whatever is in flight stale.
    const mine = ++textGeneration.current;
    if (!open) return;
    const words = query.trim();
    if (words.length < TEXT_SEARCH_MIN_LENGTH) {
      setTextHits({ query: '', hits: [] });
      return;
    }

    const timer = window.setTimeout(() => {
      api
        .search(words)
        .then(({ hits }) => {
          if (textGeneration.current === mine) setTextHits({ query: words, hits });
        })
        .catch(() => {
          if (textGeneration.current === mine) setTextHits({ query: words, hits: [] });
        });
    }, TEXT_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const words = query.trim();
  // A note already offered by its title is not offered a second time below.
  const byTitle = new Set(results.map((note) => refKey(note.owner, note.path)));
  // Hits for words since replaced stay only while they still fit: typing on from
  // "pro" to "prox" keeps them until the narrower answer lands, a different word
  // does not show the old word's notes under it.
  const inNotes =
    words.length < TEXT_SEARCH_MIN_LENGTH || !words.toLowerCase().startsWith(textHits.query.toLowerCase())
      ? []
      : textHits.hits.filter((hit) => !byTitle.has(refKey(hit.owner, hit.path))).slice(0, TEXT_HITS_SHOWN);

  const rows: Row[] = [
    ...matchCommands(commands, query).map((command): Row => ({ kind: 'command', command })),
    ...results.map((note): Row => ({ kind: 'note', note })),
    ...inNotes.map((hit): Row => ({ kind: 'text', hit })),
    ...(words !== '' && onSearchAll !== undefined ? [{ kind: 'searchAll', query: words } as Row] : []),
  ];
  // Hits arriving can shorten the list under a highlighted row.
  const current = Math.min(active, rows.length - 1);

  const choose = (row: Row | undefined): void => {
    if (row === undefined) return;
    onClose();
    if (row.kind === 'command') row.command.run();
    else if (row.kind === 'note') onOpenNote(row.note.owner, row.note.path);
    else if (row.kind === 'text') onOpenNote(row.hit.owner, row.hit.path, { snippet: row.hit.snippet, query: textHits.query });
    else onSearchAll?.(row.query);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActive(Math.min(current + 1, rows.length - 1));
    } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[current]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const folder = (path: string): string => path.split('/').slice(0, -1).join('/') || '/';

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
          {rows.map((row, index) =>
            row.kind === 'command' ? (
              <button
                type="button"
                key={`command:${row.command.key}`}
                className="palette-item palette-command"
                data-active={index === current}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                <span className="t">{row.command.label}</span>
                <span className="p">
                  {row.command.shortcut !== undefined && <kbd>{row.command.shortcut}</kbd>}
                  {copy.palette.command}
                </span>
              </button>
            ) : null,
          )}

          {results.length > 0 && words !== '' && (
            <p className="palette-section">{copy.palette.notes}</p>
          )}

          {results.length === 0 && inNotes.length === 0 && (
            <p className="empty">{query === '' ? copy.palette.recentAppearHere : copy.palette.nothingFound}</p>
          )}

          {rows.map((row, index) => {
            if (row.kind !== 'note') return null;
            const note = row.note;
            return (
              <button
                type="button"
                key={refKey(note.owner, note.path)}
                className="palette-item"
                data-active={index === current}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                <span className="t">{note.title}</span>
                <span className="p">
                  {/* Two vaults can hold the same title, so a hit that is not yours
                      has to say so — otherwise the switcher offers two identical
                      rows and picking is a coin toss. */}
                  {note.owner !== self && <span className="pill p-info">{note.owner}</span>}
                  {folder(note.path)}
                </span>
              </button>
            );
          })}

          {inNotes.length > 0 && (
            <p className="palette-section">{copy.palette.inNotes}</p>
          )}

          {rows.map((row, index) => {
            if (row.kind !== 'text') return null;
            const hit = row.hit;
            return (
              <button
                type="button"
                key={`text:${refKey(hit.owner, hit.path)}`}
                className="palette-item palette-hit"
                data-active={index === current}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                <span className="t">{hit.title}</span>
                <span className="p">
                  {hit.owner !== self && <span className="pill p-info">{hit.owner}</span>}
                  {folder(hit.path)}
                </span>
                {hit.snippet !== '' && (
                  // Text nodes and <mark> only: the excerpt is a piece of a note,
                  // and a note may hold anything that looks like markup.
                  <span className="snip">
                    {snippetParts(hit.snippet, textHits.query).map((part, at) =>
                      part.hit ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>,
                    )}
                  </span>
                )}
              </button>
            );
          })}

          {rows.map((row, index) =>
            row.kind === 'searchAll' ? (
              <button
                type="button"
                key="search-all"
                className="palette-item palette-command palette-all"
                data-active={index === current}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                <span className="t">{copy.palette.searchAll(row.query)}</span>
                <span className="p">{copy.palette.searchView}</span>
              </button>
            ) : null,
          )}
        </div>

        <div className="palette-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd> {copy.palette.choose} · <kbd>⏎</kbd> {copy.palette.open} · <kbd>Esc</kbd> {copy.palette.close}
        </div>
      </div>
    </div>
  );
}
