/**
 * The card beside a focused note in the brain.
 *
 * What a note is, what it says in its first paragraph, what it is connected to
 * and why, and what happened to it lately — each read off something that exists:
 *
 *  - title, folder, tags, last edit and every link come from the graph reply
 *    the view already holds, which the server has cut down to what the caller
 *    may see;
 *  - the summary is the note's first paragraph of prose, fetched through the
 *    ordinary note endpoint, stripped of markup and rendered as text — never as
 *    HTML, since a note may hold anything;
 *  - the activity is the note's recorded versions, from the history endpoint,
 *    and the section is left out where the host keeps none.
 *
 * No AI, and nothing inferred: a reason two notes are connected is a link, a
 * folder, a tag or a neighbour they share (`inspect.ts`).
 *
 * It sits in the brain's own container, beside the canvas, which makes it an
 * area region names keep clear of (`brain/blocked.ts`), and it carries
 * `data-brain-reserve`, which makes the focused camera frame the notes beside
 * it rather than under it.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { api } from './api';
import { noteKind } from './brain/kind';
import { copy } from './copy';
import { CloseIcon, FileIcon, TrashIcon } from './icons';
import type { GraphIndex, Neighbour } from './inspect';
import { neighbourhood, summarize, whyConnected } from './inspect';
import { absoluteTime, relativeTime } from './network/relativeTime';

/** Rows shown per direction before "show all". */
const FIRST_ROWS = 6;
/** Versions shown under activity. */
const VERSIONS = 5;
/** How long a fetched summary or history counts as fresh. */
const FRESH_MS = 30_000;

export interface InspectorProps {
  index: GraphIndex;
  /** The focused note's key. */
  picked: string;
  /** Focus another note, or end the focus with null. */
  onPick: (key: string | null) => void;
  onOpen: (owner: string, path: string) => void;
  /** Reveals the note in the sidebar's tree; the action is offered only when given. */
  onReveal?: ((owner: string, path: string) => void) | undefined;
  /**
   * Deletes the note, after the shell has asked. Given only for a note the
   * caller may change, so a note read through a read-only share offers none.
   */
  onDelete?: ((owner: string, path: string, title: string) => void) | undefined;
}

export function Inspector({ index, picked, onPick, onOpen, onReveal, onDelete }: InspectorProps): React.JSX.Element | null {
  const node = index.nodes.get(picked);
  const links = useMemo(() => neighbourhood(index, picked), [index, picked]);
  // Per note: a reason opened for one note says nothing about the next.
  const [open, setOpen] = useState<{ note: string; row: string } | null>(null);
  const why = open?.note === picked ? open.row : null;
  const setWhy = (row: string | null): void => setOpen(row === null ? null : { note: picked, row });

  // Moving the focus on from a row in here re-renders the rows, and the button
  // that had the keyboard is gone. The title takes it, so Tab carries on from
  // the top of the new note rather than from the start of the page.
  const title = useRef<HTMLHeadingElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    title.current?.focus();
  }, [picked]);
  const moveTo = (key: string): void => {
    refocus.current = true;
    onPick(key);
  };

  const owner = node?.owner ?? '';
  const path = node?.path ?? '';

  // Its own cache entry, not the editor's: the editor's never goes stale on
  // purpose, and a summary read minutes ago must not become the text somebody
  // starts typing into.
  const text = useQuery({
    queryKey: ['inspector-note', owner, path],
    queryFn: () => api.getNote(owner, path),
    enabled: node !== undefined,
    staleTime: FRESH_MS,
    retry: false,
    select: (reply) => summarize(reply.note.content),
  });

  const history = useQuery({
    queryKey: ['history', owner, path],
    queryFn: () => api.history(owner, path),
    enabled: node !== undefined,
    staleTime: FRESH_MS,
    retry: false,
  });

  if (node === undefined) return null;

  const kind = noteKind(node.folder, node.title);
  const type = kind.kind === 'folder' ? kind.label : copy.network.card.kind[kind.kind];
  const versions = history.data?.available === true ? history.data.versions.slice(0, VERSIONS) : [];
  const total = links.outgoing.length + links.incoming.length;

  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onPick(null);
  };

  return (
    <section className="inspector" aria-label={copy.inspector.label(node.title)} data-brain-reserve="" onKeyDown={onKey}>
      <header className="inspector-head">
        <FileIcon size={18} />
        <h2 className="inspector-title" ref={title} tabIndex={-1}>
          {node.title}
        </h2>
        <button
          type="button"
          className="inspector-close"
          aria-label={copy.inspector.close}
          title={copy.inspector.close}
          onClick={() => onPick(null)}
        >
          <CloseIcon size={16} />
        </button>
      </header>

      <div className="inspector-body">
        <dl className="inspector-facts">
          {type !== '' && (
            <>
              <dt>{copy.inspector.type}</dt>
              <dd>{type}</dd>
            </>
          )}
          <dt>{copy.inspector.edited}</dt>
          <dd>
            <time dateTime={new Date(node.updatedAt).toISOString()} title={absoluteTime(node.updatedAt)}>
              {relativeTime(node.updatedAt)}
            </time>
          </dd>
          <dt>{copy.inspector.tags}</dt>
          <dd>
            {node.tags.length === 0 ? (
              <span className="inspector-quiet">{copy.inspector.noTags}</span>
            ) : (
              node.tags.map((tag) => (
                <span className="inspector-tag" key={tag}>
                  #{tag}
                </span>
              ))
            )}
          </dd>
        </dl>

        {/* A failed read (gone, or no longer visible) leaves the section out
            rather than guessing at what the note says. */}
        {!text.isError && (
          <div className="inspector-section">
            <h3>{copy.inspector.summary}</h3>
            {text.isPending ? (
              <p className="inspector-quiet">{copy.inspector.summaryLoading}</p>
            ) : text.data === '' ? (
              <p className="inspector-quiet">{copy.inspector.summaryEmpty}</p>
            ) : (
              <p className="inspector-summary">{text.data}</p>
            )}
          </div>
        )}

        <div className="inspector-section">
          <h3>{copy.inspector.connected}</h3>
          {total === 0 ? (
            <p className="inspector-quiet">{copy.inspector.noLinks}</p>
          ) : (
            <>
              <Links
                key={`${picked}:out`}
                title={copy.inspector.linksTo}
                rows={links.outgoing}
                from={picked}
                index={index}
                why={why}
                onWhy={setWhy}
                onPick={moveTo}
              />
              <Links
                key={`${picked}:in`}
                title={copy.inspector.linkedFrom}
                rows={links.incoming}
                from={picked}
                index={index}
                why={why}
                onWhy={setWhy}
                onPick={moveTo}
              />
            </>
          )}
        </div>

        {versions.length > 0 && (
          <div className="inspector-section">
            <h3>{copy.inspector.activity}</h3>
            <ul className="inspector-activity">
              {versions.map((version) => (
                <li key={version.id}>
                  <span>{copy.inspector.changed}</span>
                  <time dateTime={new Date(version.at).toISOString()} title={absoluteTime(version.at)}>
                    {relativeTime(version.at)}
                  </time>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className="inspector-actions">
        <button type="button" className="inspector-open" onClick={() => onOpen(node.owner, node.path)}>
          {copy.inspector.open}
        </button>
        {onReveal !== undefined && (
          <button type="button" className="inspector-reveal" onClick={() => onReveal(node.owner, node.path)}>
            {copy.inspector.reveal}
          </button>
        )}
        {onDelete !== undefined && (
          <button
            type="button"
            className="inspector-delete"
            aria-label={copy.tree.deleteNoteLabel(node.title)}
            title={copy.tree.deleteNoteLabel(node.title)}
            onClick={() => onDelete(node.owner, node.path, node.title)}
          >
            <TrashIcon size={15} />
            <span>{copy.inspector.delete}</span>
          </button>
        )}
      </footer>
    </section>
  );
}

/** One direction of links: a short list, a way to see all, and a reason per row. */
function Links({
  title,
  rows,
  from,
  index,
  why,
  onWhy,
  onPick,
}: {
  title: string;
  rows: Neighbour[];
  from: string;
  index: GraphIndex;
  /** The row whose reason is open, by key; the same key may sit in both lists. */
  why: string | null;
  onWhy: (row: string | null) => void;
  onPick: (key: string) => void;
}): React.JSX.Element | null {
  const [all, setAll] = useState(false);
  const id = useId();
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const whyKey = (row: Neighbour): string => `${title} ${row.key}`;

  return (
    <div className="inspector-links">
      <h4 id={id}>
        {title} <span className="inspector-count">{rows.length}</span>
      </h4>
      <ul aria-labelledby={id}>
        {shown.map((row) => {
          const open = why === whyKey(row);
          const reasonId = `${id}-${row.key.replace(/[^\w-]/g, '_')}`;
          return (
            <li key={row.key}>
              <div className="inspector-row">
                <button
                  type="button"
                  className="inspector-neighbour"
                  aria-label={copy.inspector.focus(row.title)}
                  onClick={() => onPick(row.key)}
                >
                  <span className="inspector-neighbour-title">{row.title}</span>
                  {row.folder !== '' && <span className="inspector-neighbour-folder">{row.folder}</span>}
                </button>
                <button
                  type="button"
                  className="inspector-why"
                  aria-expanded={open}
                  aria-controls={open ? reasonId : undefined}
                  aria-label={copy.inspector.whyLabel(row.title)}
                  title={copy.inspector.whyLabel(row.title)}
                  onClick={() => onWhy(open ? null : whyKey(row))}
                >
                  {copy.inspector.why}
                </button>
              </div>
              {open && <Reason id={reasonId} index={index} from={from} to={row.key} />}
            </li>
          );
        })}
      </ul>
      {rows.length > FIRST_ROWS && (
        <button type="button" className="inspector-more" onClick={() => setAll((v) => !v)}>
          {all ? copy.inspector.showFewer : copy.inspector.showAll(rows.length)}
        </button>
      )}
    </div>
  );
}

/** "direct link · same folder `21_Homelab` · 2 shared tags · 3 shared neighbours" */
function Reason({ id, index, from, to }: { id: string; index: GraphIndex; from: string; to: string }): React.JSX.Element {
  const reasons = whyConnected(index, from, to);
  const parts: React.ReactNode[] = [];
  if (reasons.link !== null) parts.push(copy.inspector.reason[reasons.link]);
  if (reasons.folder !== null) {
    parts.push(
      <>
        {reasons.folder.same ? copy.inspector.reason.sameFolder : copy.inspector.reason.underFolder}{' '}
        <code>{reasons.folder.name}</code>
      </>,
    );
  }
  if (reasons.tags.length > 0) {
    parts.push(
      <>
        {copy.inspector.reason.tags(reasons.tags.length)}{' '}
        <span className="inspector-quiet">{reasons.tags.slice(0, 3).map((t) => `#${t}`).join(' ')}</span>
      </>,
    );
  }
  if (reasons.shared > 0) parts.push(copy.inspector.reason.neighbours(reasons.shared));

  return (
    <p className="inspector-reason" id={id}>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span className="inspector-dot" aria-hidden="true"> · </span>}
          {part}
        </span>
      ))}
    </p>
  );
}
