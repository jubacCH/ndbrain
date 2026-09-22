/**
 * The panel beside the brain, in its three forms.
 *
 * One slot, and what is picked decides what stands in it: a note
 * (`Inspector`), a whole knowledge area (`RegionInspector`), or one link
 * (`LinkInspector`). They share this file because they share the slot, the
 * head with its close button, the Escape that gives the keyboard back to the
 * canvas and every rule below about where the panel sits — splitting them
 * would be three copies of all of that.
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
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';

import { api } from './api';
import { noteKind } from './brain/kind';
import { copy } from './copy';
import { BrainIcon, CloseIcon, FileIcon, NetworkIcon, ShareIcon, SpaceIcon, TrashIcon } from './icons';
import { ownerKind, ownerLabel, useOwners } from './owners';
import type { GraphIndex, Neighbour, RegionMember } from './inspect';
import { neighbourhood, regionFacts, summarize, whyConnected } from './inspect';
import { absoluteTime, relativeTime } from './network/relativeTime';
import { refKey } from './refkey';

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
  /**
   * Opens the share dialog. Given only for a note the caller may share: their
   * own, or, for an administrator, one in a space.
   */
  onShare?: ((owner: string, path: string, title: string) => void) | undefined;
  /** The signed-in account; a note from any other vault says whose it is. */
  self?: string | undefined;
}

export function Inspector({
  index,
  picked,
  onPick,
  onOpen,
  onReveal,
  onDelete,
  onShare,
  self,
}: InspectorProps): React.JSX.Element | null {
  const node = index.nodes.get(picked);
  const owners = useOwners();
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
          {ownerKind(owners, owner) === 'space' ? (
            <>
              <dt>{copy.inspector.space}</dt>
              <dd className="inspector-owner">
                <SpaceIcon size={14} />
                {ownerLabel(owners, owner)}
              </dd>
            </>
          ) : (
            self !== undefined &&
            owner !== self && (
              <>
                <dt>{copy.inspector.vault}</dt>
                <dd className="inspector-owner">{owner}</dd>
              </>
            )
          )}
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
        {onShare !== undefined && (
          <button
            type="button"
            className="inspector-share"
            aria-label={copy.tree.shareNoteLabel(node.title)}
            title={copy.tree.shareNoteLabel(node.title)}
            onClick={() => onShare(node.owner, node.path, node.title)}
          >
            <ShareIcon size={15} />
            <span>{copy.shareNote.menu}</span>
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

/* ===================== a whole knowledge area ===================== */

/** Notes shown under "most connected" before "show all". */
const STRONG_ROWS = 6;
/** Tags shown under a region's topics. */
const TOPIC_ROWS = 8;

export interface RegionInspectorProps {
  index: GraphIndex;
  /** The region's display name, as the layout calls it. */
  name: string;
  /** Its notes, by key. Which notes share a cell is the layout's answer. */
  members: readonly string[];
  /** Focuses one of its notes, or ends the selection with null. */
  onPick: (key: string | null) => void;
  onOpen: (owner: string, path: string) => void;
}

/**
 * The panel beside a picked region: what this knowledge area holds.
 *
 * The briefing's point 19 — "Orbit8 · 124 Notes · 18 Resources · 8 MOCs ·
 * 6 Projects · Last active: Today" — minus the three tabs that need an AI to
 * write them. What is left is countable, and `regionFacts` counts it: how many
 * notes and of which kind, the tags they share, when one of them was last
 * written, and which of them are the most connected — the briefing's "strong
 * connections" (point 29) for this area.
 *
 * Nothing is estimated. A region whose notes carry no tags says so.
 */
export function RegionInspector({ index, name, members, onPick, onOpen }: RegionInspectorProps): React.JSX.Element {
  const facts = useMemo(() => regionFacts(index, members), [index, members]);
  const [all, setAll] = useState(false);
  const id = useId();
  const shown = all ? facts.strongest : facts.strongest.slice(0, STRONG_ROWS);

  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onPick(null);
  };

  return (
    <section
      className="inspector"
      aria-label={copy.inspector.region.label(name)}
      data-brain-reserve=""
      onKeyDown={onKey}
    >
      <header className="inspector-head">
        <BrainIcon size={18} />
        <h2 className="inspector-title" tabIndex={-1}>
          {name}
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
          <dt>{copy.inspector.type}</dt>
          <dd>{copy.inspector.region.area}</dd>
          <dt>{copy.inspector.region.notes}</dt>
          <dd>{facts.notes}</dd>
          {/* Left out rather than guessed at where the region holds no note the
              reply carries: there is no date to show. */}
          {facts.lastActive !== null && (
            <>
              <dt>{copy.inspector.region.lastActive}</dt>
              <dd>
                <time dateTime={new Date(facts.lastActive).toISOString()} title={absoluteTime(facts.lastActive)}>
                  {relativeTime(facts.lastActive)}
                </time>
              </dd>
            </>
          )}
          <dt>{copy.inspector.region.topics}</dt>
          <dd>
            {facts.tags.length === 0 ? (
              <span className="inspector-quiet">{copy.inspector.region.noTopics}</span>
            ) : (
              facts.tags.slice(0, TOPIC_ROWS).map((t) => (
                <span className="inspector-tag" key={t.tag}>
                  #{t.tag}
                </span>
              ))
            )}
          </dd>
        </dl>

        {facts.notes === 0 ? (
          <p className="inspector-quiet">{copy.inspector.region.empty}</p>
        ) : (
          <div className="inspector-section">
            <h3>{copy.inspector.region.contents}</h3>
            <dl className="inspector-facts">
              {facts.kinds.map((k) => (
                <Fragment key={`${k.kind}\u0000${k.label}`}>
                  <dt>{k.kind === 'folder' ? k.label : copy.network.card.kind[k.kind]}</dt>
                  <dd>{k.count}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        )}

        <div className="inspector-section">
          <h3 id={id}>
            {copy.inspector.region.strongest}
            {facts.strongest.length > 0 && <span className="inspector-count">{facts.strongest.length}</span>}
          </h3>
          {facts.strongest.length === 0 ? (
            <p className="inspector-quiet">{copy.inspector.region.noStrongest}</p>
          ) : (
            <>
              <ul className="inspector-links" aria-labelledby={id}>
                {shown.map((row) => (
                  <li key={row.key}>
                    <Strong row={row} onPick={onPick} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
              {facts.strongest.length > STRONG_ROWS && (
                <button type="button" className="inspector-more" onClick={() => setAll((v) => !v)}>
                  {all ? copy.inspector.showFewer : copy.inspector.showAll(facts.strongest.length)}
                </button>
              )}
            </>
          )}
        </div>

        <p className="inspector-hint">{copy.inspector.region.hint}</p>
      </div>
    </section>
  );
}

/** One of a region's most connected notes: focus it, or open it. */
function Strong({
  row,
  onPick,
  onOpen,
}: {
  row: RegionMember;
  onPick: (key: string) => void;
  onOpen: (owner: string, path: string) => void;
}): React.JSX.Element {
  return (
    <div className="inspector-row">
      <button
        type="button"
        className="inspector-neighbour"
        aria-label={copy.inspector.focus(row.title)}
        onClick={() => onPick(row.key)}
        onDoubleClick={() => onOpen(row.owner, row.path)}
      >
        <span className="inspector-neighbour-title">{row.title}</span>
        {row.folder !== '' && <span className="inspector-neighbour-folder">{row.folder}</span>}
      </button>
      <span className="inspector-degree">{copy.inspector.region.links(row.links)}</span>
    </div>
  );
}

/* ===================== one link ===================== */

export interface LinkInspectorProps {
  index: GraphIndex;
  /** The two notes, in the direction the link is written. */
  from: string;
  to: string;
  /** Focuses one of them, or ends the selection with null. */
  onPick: (key: string | null) => void;
  onOpen: (owner: string, path: string) => void;
}

/**
 * The panel beside a picked link: why these two notes are connected.
 *
 * Briefing point 22, which calls this extremely important — an AI relationship
 * must not be a black box. There is no AI here and so no box: the reason is a
 * link, a folder, a tag or a neighbour the two share, read off the structure
 * (`whyConnected`). The briefing's example ends with "semantic similarity 87 %
 * · source: AI suggested"; a number like that is exactly what this view does
 * not have, so it is not shown.
 *
 * Until now this reason existed only behind a "Why?" button on a row of a
 * focused note's neighbour list — two clicks and a selection away from the
 * link somebody was looking at.
 */
export function LinkInspector({ index, from, to, onPick, onOpen }: LinkInspectorProps): React.JSX.Element | null {
  const a = index.nodes.get(from);
  const b = index.nodes.get(to);
  const id = useId();

  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onPick(null);
  };

  if (a === undefined || b === undefined) return null;

  return (
    <section
      className="inspector"
      aria-label={copy.inspector.link.label(a.title, b.title)}
      data-brain-reserve=""
      onKeyDown={onKey}
    >
      <header className="inspector-head">
        <NetworkIcon size={18} />
        <h2 className="inspector-title" tabIndex={-1}>
          {a.title} · {b.title}
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
        <div className="inspector-section">
          <h3>{copy.inspector.link.heading}</h3>
          <Reason id={id} index={index} from={from} to={to} />
        </div>

        <div className="inspector-section">
          <h3>{copy.inspector.link.between}</h3>
          <ul className="inspector-links">
            {[a, b].map((node) => (
              <li key={`${node.owner}\u0000${node.path}`}>
                <div className="inspector-row">
                  <button
                    type="button"
                    className="inspector-neighbour"
                    aria-label={copy.inspector.focus(node.title)}
                    onClick={() => onPick(refKey(node.owner, node.path))}
                    onDoubleClick={() => onOpen(node.owner, node.path)}
                  >
                    <span className="inspector-neighbour-title">{node.title}</span>
                    {node.folder !== '' && <span className="inspector-neighbour-folder">{node.folder}</span>}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="inspector-hint">{copy.inspector.link.hint}</p>
      </div>
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
  const whyKey = (row: Neighbour): string => `${title}\u0000${row.key}`;

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
