/**
 * The folder tree.
 *
 * Arbitrary depth, because the vault is a plain folder and the tool does not
 * prescribe a structure. Nothing here knows a folder name — no special casing
 * for an inbox or an archive — since that would quietly impose the very
 * convention the product refuses to impose.
 *
 * Every note that has a finding carries a thin coloured tick at the left edge of
 * its row. That is the signature device: the health of the vault is visible in
 * passing, without opening a view for it.
 *
 * Since sharing, the tree can show more than one vault. Foreign notes are never
 * mixed into your own folders, however neatly the paths would line up: a
 * `Homelab` somebody shared with you and your own `Homelab` are different
 * places, and merging them would make "delete this folder" ambiguous at exactly
 * the wrong moment. Each vault is its own labelled section, your own first.
 *
 * Spaces come next, each its own root under its display name and the space
 * icon, and only then other people's vaults. A space is not somebody who shared
 * a folder with you; it is a place you are a member of, and mixing it into the
 * list of people would make "Familie" look like a person called Familie. A space
 * you belong to is shown even while it is empty, so there is somewhere to start
 * its first note.
 *
 * Three habits keep it legible as a vault grows, none of which touch the files:
 *
 * - It starts closed. Measured on a real vault, 72% of notes hung under a single
 *   branch, so opening everything by default meant scrolling a long alphabetical
 *   list to reach anything.
 * - Typing filters. Past a few hundred folders nobody scrolls to a note, and a
 *   filtered *tree* still makes you read the hierarchy — so matches are listed
 *   flat, each under its own path.
 * - Sort prefixes are hidden. `00_`, `20_` and friends exist to make a dumb file
 *   browser sort correctly; a tool that sorts deliberately does not need to read
 *   them out. Display only — the path on disk is untouched, and links keep
 *   resolving against the real name.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { copy } from './copy';

import { refKey, type NoteRow, type Share } from './api';
import { loadOpenFolders, saveOpenFolders } from './accountStorage';
import { ChevronIcon, FileIcon, FolderIcon, NewNoteIcon, PencilIcon, ShareIcon, SpaceIcon, TrashIcon } from './icons';
import { ownerKind, ownerLabel, useOwners } from './owners';
import type { Trouble as TroubleKind } from './queries';
import { mayChange } from './rights';
import { Trouble } from './Trouble';

export type Finding = 'crit' | 'warn';

/**
 * The name without its sort prefix.
 *
 * Deliberately narrow: digits, one separator, then a character that is not a
 * digit. `21_Homelab` loses its prefix; `2026-07-27` and `100 Ideen` keep every
 * character, because those digits are the name rather than a sorting device.
 */
export function displayName(name: string, hide = true): string {
  if (!hide) return name;
  const stripped = name.replace(/^\d{1,3}[_\-.]\s*(?=\D)/, '');
  return stripped === '' ? name : stripped;
}

/** A path with each segment de-prefixed, for the breadcrumb under a hit. */
export function displayPath(path: string, hide = true): string {
  const segments = path.split('/');
  segments.pop();
  return segments.map((segment) => displayName(segment, hide)).join(' › ');
}

export interface TreeProps {
  notes: NoteRow[];
  /** The signed-in account, whose vault is shown first and without a header. */
  self: string;
  /** What has been shared *with* the caller — the source of the section labels. */
  received: Share[];
  selected: { owner: string; path: string } | null;
  findings: Map<string, Finding>;
  /** Lower-cased already; empty means show the tree rather than a result list. */
  filter: string;
  /**
   * Whether `00_`-style sort prefixes are hidden.
   *
   * A preference rather than a rule: right for a vault using Johnny-Decimal
   * folders, wrong for one where the digits are part of the name. Display only —
   * `onSelect` always hands back the real path.
   */
  hidePrefixes: boolean;
  onSelect: (owner: string, path: string) => void;
  /**
   * Offered on your own folders only. A folder move relocates everything under
   * it, and a shared region is a *part* of somebody's vault — a rename that
   * straddles its edge has no good answer, so it is not offered.
   */
  onRenameFolder: (path: string) => void;
  /**
   * Deletes a note, after the shell has asked. Offered on every note the caller
   * may change (`rights.ts`) — as a button at the end of the row, and as the
   * Delete key on a focused row — and on no other.
   */
  onDeleteNote?: (owner: string, path: string, title: string) => void;
  /**
   * Renames or moves a note, through the shell's dialog. Offered on the same
   * notes as the delete — every note the caller may change — as a pencil at the
   * end of the row and as F2 on a focused row, which is what a file manager
   * taught everybody that key does.
   */
  onRenameNote?: (owner: string, path: string, title: string) => void;
  /**
   * A note to show without opening it: the folders above it open, the row is
   * marked and scrolled into view. `seq` makes a second request for the same
   * note scroll again, after the tree has been scrolled away from it.
   */
  revealed?: { owner: string; path: string; seq: number } | null;
  /** Offered on the first-run empty state only. */
  onCreateFirst?: () => void;
  /**
   * Why the note list is empty, when the reason is not that it is empty.
   *
   * Without this the tree cannot tell a new vault from a request that failed —
   * both arrive here as `notes: []` — and it showed the first-run invitation to
   * both. Somebody whose vault had not loaded was told to start their first
   * note, which is the single most alarming thing this interface could say.
   */
  trouble?: TroubleKind | null;
  /** Asks the server again, from the message `trouble` puts on screen. */
  onRetry?: () => void;
  /**
   * Opens the share dialog for a note. Offered on exactly the notes
   * `mayShareNote` allows: your own, or, for an administrator, a space's.
   */
  onShareNote?: (owner: string, path: string, title: string) => void;
  mayShareNote?: (owner: string) => boolean;
  /**
   * Starts a note in a space. Offered on a space's header only where some share
   * on it carries write access; the path typed is checked again before sending.
   */
  onCreateIn?: (owner: string) => void;
}

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  notes: NoteRow[];
}

function buildTree(notes: NoteRow[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], notes: [] };

  for (const note of notes) {
    const segments = note.path.split('/');
    const fileName = segments.pop();
    if (fileName === undefined) continue;

    let folder = root;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      let next = folder.folders.find((f) => f.name === segment);
      if (next === undefined) {
        next = { name: segment, path: prefix, folders: [], notes: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.notes.push(note);
  }

  // Sorted on the real name, so a vault that uses numeric prefixes keeps the
  // order they were chosen for even though the digits are not shown.
  const sort = (folder: Folder): void => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.notes.sort((a, b) => a.title.localeCompare(b.title));
    folder.folders.forEach(sort);
  };
  sort(root);

  return root;
}

/**
 * How much of a foreign vault the caller may change.
 *
 * Only ever a label. The binding answer comes from the server when the note is
 * opened, and the editor locks on that — a hint computed here from a share list
 * that may be a few seconds stale must never be what decides whether a write is
 * attempted.
 */
function writeLabel(owner: string, received: Share[]): string | null {
  const mine = received.filter((share) => share.owner === owner);
  if (mine.length === 0 || mine.every((share) => !share.canWrite)) return copy.shares.readOnly;
  if (mine.every((share) => share.canWrite)) return copy.shares.readWrite;
  return copy.shares.partlyWritable;
}

/** Every ancestor folder of a note, so the selection can reveal itself. */
function ancestors(owner: string, path: string): string[] {
  const segments = path.split('/');
  segments.pop();
  const out: string[] = [];
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    out.push(refKey(owner, prefix));
  }
  return out;
}


/**
 * Roving focus across whatever rows are currently on screen.
 *
 * Deliberately reads the DOM rather than mirroring the tree in state. The rows
 * that exist at any moment are the product of folder state, the filter and the
 * shares; keeping a parallel model of that in JavaScript means two things that
 * can disagree, and the one that is wrong is always the one steering the
 * keyboard.
 *
 * Keys follow the ARIA tree pattern, which people already know from every file
 * manager: up and down move, right opens a folder or steps into it, left closes
 * it or steps out to the parent, Home and End jump to the ends.
 */
function useTreeKeys(
  container: React.RefObject<HTMLDivElement | null>,
  onDelete: ((row: HTMLElement) => void) | undefined,
  onRename: ((row: HTMLElement) => void) | undefined,
) {
  const rows = (): HTMLButtonElement[] =>
    [...(container.current?.querySelectorAll<HTMLButtonElement>('button.node') ?? [])];

  const move = (from: HTMLElement, delta: number): void => {
    const all = rows();
    const index = all.indexOf(from as HTMLButtonElement);
    const next = all[Math.min(all.length - 1, Math.max(0, index + delta))];
    // The tab stop follows the focus rather than being moved separately: the
    // container's focus handler seats whichever row ends up with it, so there
    // is one place where that happens and not two that can disagree.
    next?.focus();
  };

  return (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('node')) return;

    const expanded = target.getAttribute('aria-expanded');

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(target, 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(target, -1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        // A shut folder opens; an open one hands focus to its first child, which
        // is the row directly below it.
        if (expanded === 'false') target.click();
        else if (expanded === 'true') move(target, 1);
        break;
      case 'ArrowLeft': {
        event.preventDefault();
        if (expanded === 'true') {
          target.click();
          break;
        }
        // Otherwise walk up to the nearest shallower row — the parent folder,
        // whatever the nesting depth happens to be. Read off `aria-level`,
        // which every row now carries for the same reason a screen reader
        // needs it: counting ancestor `<ul>`s was the same number computed a
        // second way, and only one of the two was ever announced.
        const all = rows();
        const index = all.indexOf(target as HTMLButtonElement);
        const depth = (el: HTMLElement): number => Number(el.getAttribute('aria-level') ?? '1');
        const mine = depth(target);
        for (let i = index - 1; i >= 0; i -= 1) {
          if (depth(all[i]!) < mine) {
            all[i]!.focus();
            break;
          }
        }
        break;
      }
      case 'Home':
        event.preventDefault();
        rows()[0]?.focus();
        break;
      case 'End': {
        event.preventDefault();
        const all = rows();
        all[all.length - 1]?.focus();
        break;
      }
      // F2, as in every file manager. Same rule as the delete below: only a row
      // the caller may change carries an attribute — `data-renamable` on a note,
      // `data-folder` on a folder of your own — and the key does nothing on the
      // rest.
      case 'F2':
        if (
          onRename === undefined ||
          !(target.hasAttribute('data-renamable') || target.hasAttribute('data-folder'))
        ) {
          break;
        }
        event.preventDefault();
        onRename(target);
        break;
      // Delete, or ⌘⌫ as in the Finder. Only on a note row the caller may
      // change: that row carries the attribute, a folder or a read-only note
      // does not, and the key does nothing there.
      case 'Delete':
      case 'Backspace':
        if (event.key === 'Backspace' && !event.metaKey) break;
        if (onDelete === undefined || !target.hasAttribute('data-deletable')) break;
        event.preventDefault();
        onDelete(target);
        break;
      default:
    }
  };
}

export function Tree({
  notes,
  self,
  received,
  selected,
  findings,
  filter,
  hidePrefixes,
  onSelect,
  onRenameFolder,
  onDeleteNote,
  onRenameNote,
  revealed = null,
  onCreateFirst,
  trouble = null,
  onRetry,
  onShareNote,
  mayShareNote,
  onCreateIn,
}: TreeProps): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const owners = useOwners();
  /** The note a focused row stands for, for the keys that act on one. */
  const noteOf = (row: HTMLElement): NoteRow | undefined => {
    const owner = row.getAttribute('data-owner');
    const path = row.getAttribute('data-path');
    return notes.find((n) => n.owner === owner && n.path === path);
  };
  const onKeyDown = useTreeKeys(
    box,
    onDeleteNote === undefined
      ? undefined
      : (row) => {
          const note = noteOf(row);
          if (note !== undefined) onDeleteNote(note.owner, note.path, note.title);
        },
    // F2 on a folder row and F2 on a note row are the same key doing the same
    // thing to different rows; the row says which it is. Always offered,
    // because renaming a folder always is — a vault with no rename for its
    // notes still has one for its folders.
    (row) => {
      const folder = row.getAttribute('data-folder');
      if (folder !== null) {
        onRenameFolder(folder);
        return;
      }
      const note = noteOf(row);
      if (note !== undefined) onRenameNote?.(note.owner, note.path, note.title);
    },
  );

  /**
   * The row that holds the tree's single tab stop.
   *
   * Every row was reachable by Tab before, which is the canonical hobby-tool
   * failure: sixty presses to get past the sidebar. Only one row is in the tab
   * order; the arrow keys do the rest.
   *
   * The seat moves with the focus. Without that, `move()` focused a row and
   * left the tab stop on row one, so Tab out of the tree and back in threw away
   * wherever you had got to — the exact state a roving tabindex exists to
   * prevent, and the one nobody notices until they try it.
   *
   * Read off the DOM, like the keys above and for the same reason: the rows
   * that exist at any moment are the product of folder state, the filter and
   * the shares, and a second model of that is a second thing that can be wrong.
   */
  const seated = useRef<HTMLButtonElement | null>(null);
  const seat = (row: HTMLButtonElement | null): void => {
    const all = [...(box.current?.querySelectorAll<HTMLButtonElement>('button.node') ?? [])];
    // A row that has been filtered or folded away cannot hold the seat; the
    // first row takes it back, so the tree is never unreachable by Tab.
    const chosen = row !== null && all.includes(row) ? row : (all[0] ?? null);
    seated.current = chosen;
    for (const one of all) one.tabIndex = one === chosen ? 0 : -1;
  };
  // Every render, because every render can add and remove rows.
  useLayoutEffect(() => {
    seat(seated.current);
  });

  const vaults = useMemo(() => {
    const byOwner = new Map<string, NoteRow[]>();
    for (const note of notes) {
      const list = byOwner.get(note.owner);
      if (list === undefined) byOwner.set(note.owner, [note]);
      else list.push(note);
    }

    // Own vault first and always present, so a vault that has been emptied still
    // shows its "create the first note" prompt rather than vanishing behind
    // somebody else's folders.
    const own = byOwner.get(self) ?? [];
    byOwner.delete(self);

    // A space you are a member of is there before its first note is.
    for (const share of received) {
      if (share.owner !== self && ownerKind(owners, share.owner) === 'space' && !byOwner.has(share.owner)) {
        byOwner.set(share.owner, []);
      }
    }

    const foreign = [...byOwner.entries()].map(([owner, rows]) => ({
      owner,
      rows,
      space: ownerKind(owners, owner) === 'space',
      label: ownerLabel(owners, owner),
    }));
    const spaces = foreign.filter((v) => v.space).sort((a, b) => a.label.localeCompare(b.label));
    const people = foreign.filter((v) => !v.space).sort((a, b) => a.owner.localeCompare(b.owner));

    return [{ owner: self, rows: own, space: false, label: self }, ...spaces, ...people];
  }, [notes, self, received, owners]);

  // Which folders are *open*, not which are closed: the default has to survive
  // a vault growing a new folder, and an unknown folder should start shut.
  // Kept per account: the keys name folders, and the next person signing in on
  // this browser must not find them (see `accountStorage.ts`).
  const [open, setOpen] = useState<Set<string>>(() => loadOpenFolders(self));

  useEffect(() => {
    saveOpenFolders(self, open);
  }, [self, open]);

  // Opening a note from search, from a link or from the palette reveals it in
  // the tree. Without this the selected row would sit inside a shut folder and
  // the tree would look like it had lost track of where you are.
  useEffect(() => {
    if (selected === null) return;
    const needed = ancestors(selected.owner, selected.path);
    setOpen((previous) => {
      if (needed.every((key) => previous.has(key))) return previous;
      const next = new Set(previous);
      for (const key of needed) next.add(key);
      return next;
    });
  }, [selected]);

  // Showing a note from elsewhere — the inspector's "Show in tree" — opens the
  // same way, without touching the selection: nothing is opened.
  useEffect(() => {
    if (revealed === null) return;
    const needed = ancestors(revealed.owner, revealed.path);
    setOpen((previous) => {
      if (needed.every((key) => previous.has(key))) return previous;
      const next = new Set(previous);
      for (const key of needed) next.add(key);
      return next;
    });
  }, [revealed]);

  // Scrolled to once the row exists, which is after the folders above it have
  // rendered open — hence keyed on `open` as well, and once per request.
  const scrolled = useRef<number | null>(null);
  useEffect(() => {
    if (revealed === null || scrolled.current === revealed.seq) return;
    const row = box.current?.querySelector<HTMLElement>('[data-revealed="true"]');
    if (row === null || row === undefined) return;
    scrolled.current = revealed.seq;
    // Absent in some test environments; a tree that cannot scroll still opens.
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [revealed, open]);

  const toggle = (key: string): void => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const noteRow = (note: NoteRow, showPath: boolean, level: number): React.JSX.Element => {
    const key = refKey(note.owner, note.path);
    const finding = findings.get(key);
    const where = displayPath(note.path, hidePrefixes);
    const changeable = mayChange(self, received, note.owner, note.path);
    const deletable = onDeleteNote !== undefined && changeable;
    const renamable = onRenameNote !== undefined && changeable;
    const shareable = onShareNote !== undefined && mayShareNote !== undefined && mayShareNote(note.owner);
    const isRevealed = revealed !== null && revealed.owner === note.owner && revealed.path === note.path;
    return (
      <li key={`f:${key}`} role="none">
        <div className="node-row" role="none">
          <button
            type="button"
            className={showPath ? 'node node-hit' : 'node'}
            role="treeitem"
            aria-level={level}
            // Seated by the layout effect above, never by the render: which row
            // holds the tab stop depends on where the focus has been.
            tabIndex={-1}
            aria-selected={selected !== null && selected.owner === note.owner && selected.path === note.path}
            data-owner={note.owner}
            data-path={note.path}
            data-deletable={deletable ? '' : undefined}
            data-renamable={renamable ? '' : undefined}
            data-revealed={isRevealed ? 'true' : undefined}
            aria-keyshortcuts={
              [deletable ? 'Delete Meta+Backspace' : '', renamable ? 'F2' : '']
                .filter((keys) => keys !== '')
                .join(' ') || undefined
            }
            onClick={() => onSelect(note.owner, note.path)}
          >
            {finding !== undefined && <span className={`st st-${finding}`} />}
            {!showPath && <span className="tw" />}
            {!showPath && <FileIcon size={15} className="node-icon" />}
            <span className="nm">{note.title}</span>
            {showPath && where !== '' && <span className="where">{where}</span>}
          </button>
          {/* Out of the tab order, like every row but one: the keyboard reaches
              them as F2 and Delete on the row, which their titles name.

              In one box rather than three loose buttons. In the sidebar the row
              actions are lifted out of the flow and laid over the end of the
              row, and three absolutely positioned buttons would sit on top of
              each other — which is what the share and the bin already did. */}
          <span className="node-acts">
          {renamable && (
            <button
              type="button"
              className="node-act node-rename"
              tabIndex={-1}
              title={copy.tree.renameNote(note.title)}
              aria-label={copy.tree.renameNoteLabel(note.title)}
              onClick={() => onRenameNote?.(note.owner, note.path, note.title)}
            >
              <PencilIcon size={14} />
            </button>
          )}
          {shareable && (
            <button
              type="button"
              className="node-act node-share"
              tabIndex={-1}
              title={copy.tree.shareNote(note.title)}
              aria-label={copy.tree.shareNoteLabel(note.title)}
              onClick={() => onShareNote?.(note.owner, note.path, note.title)}
            >
              <ShareIcon size={14} />
            </button>
          )}
          {deletable && (
            <button
              type="button"
              className="node-act node-del"
              tabIndex={-1}
              title={copy.tree.deleteNote(note.title)}
              aria-label={copy.tree.deleteNoteLabel(note.title)}
              onClick={() => onDeleteNote?.(note.owner, note.path, note.title)}
            >
              <TrashIcon size={14} />
            </button>
          )}
          </span>
        </div>
      </li>
    );
  };

  const renderFolder = (owner: string, folder: Folder, level: number): React.JSX.Element[] => [
    ...folder.folders.map((child) => {
      const key = refKey(owner, child.path);
      const isOpen = open.has(key);
      const count = countNotes(child);
      // A folder move relocates everything under it, so it is offered on your
      // own vault only — the same rule for the pencil and for the key.
      const renamable = owner === self;
      return (
        <li key={`d:${key}`} role="none">
          <div className="node-row" role="none">
            <button
              type="button"
              className="node"
              role="treeitem"
              aria-level={level}
              tabIndex={-1}
              data-folder={renamable ? child.path : undefined}
              aria-keyshortcuts={renamable ? 'F2' : undefined}
              onClick={() => toggle(key)}
              aria-expanded={isOpen}
            >
              <span className="tw" data-open={isOpen}>
                <ChevronIcon size={12} />
              </span>
              <FolderIcon size={15} className="node-icon" />
              <span className="nm">{displayName(child.name, hidePrefixes)}</span>
              {/* Shown only while shut: once it is open you can see them. */}
              {!isOpen && <span className="cnt">{count}</span>}
            </button>
            {renamable && (
              <span className="node-acts">
                {/* Out of the tab order like every other row action: it was the
                    last one left in it, so Tab still walked the whole tree one
                    folder at a time. The keyboard reaches it as F2 on the row,
                    which the title names. */}
                <button
                  type="button"
                  className="node-act"
                  tabIndex={-1}
                  title={copy.tree.renameFolder(displayName(child.name, hidePrefixes))}
                  aria-label={copy.tree.renameFolderLabel(displayName(child.name, hidePrefixes))}
                  onClick={() => onRenameFolder(child.path)}
                >
                  <PencilIcon size={14} />
                </button>
              </span>
            )}
          </div>
          {isOpen && <ul role="group">{renderFolder(owner, child, level + 1)}</ul>}
        </li>
      );
    }),
    ...folder.notes.map((note) => noteRow(note, false, level)),
  ];

  return (
    <div
      className="treebox"
      ref={box}
      onKeyDown={onKeyDown}
      // Focus bubbles here from whichever row took it — a key, a click, Tab.
      onFocus={(event) => {
        const target = event.target as HTMLElement;
        if (target.classList.contains('node')) seat(target as HTMLButtonElement);
      }}
      role="tree"
      aria-label={copy.tree.label}
    >
      {vaults.map(({ owner, rows, space, label }) => {
        const isOwn = owner === self;
        const writable = received.some((share) => share.owner === owner && share.canWrite && share.kind !== 'note');
        const hits =
          filter === '' ? [] : rows.filter((note) => matches(note, filter)).slice(0, 60);

        return (
          <section className="vault" key={owner} data-foreign={!isOwn} data-kind={space ? 'space' : 'person'}>
            {/*
              Your own vault carries no header at all. Labelling it "Julian" would
              make the single-user case — which is every case until somebody
              shares something — look like it has an owner problem.
            */}
            {!isOwn && (
              <h3 className="vault-head">
                {space && <SpaceIcon size={14} className="vault-icon" />}
                <span className="vault-owner">{label}</span>
                {/* Neutral, not coloured: the right is a fact about the folder,
                    not a finding. Colour in this interface always means
                    "something is wrong here" or "this is not yours", and the
                    header itself already carries the second. */}
                <span className="pill p-tag">{writeLabel(owner, received)}</span>
                {space && writable && onCreateIn !== undefined && (
                  <button
                    type="button"
                    className="node-act vault-new"
                    title={copy.tree.newNoteIn(label)}
                    aria-label={copy.tree.newNoteIn(label)}
                    onClick={() => onCreateIn(owner)}
                  >
                    <NewNoteIcon size={14} />
                  </button>
                )}
              </h3>
            )}

            {rows.length === 0 && trouble !== null && onRetry !== undefined ? (
              /* Not the empty state. Nothing is known about this vault right
                 now, and "you have no notes" is a claim about it. */
              isOwn ? <Trouble kind={trouble} what={copy.trouble.notes} onRetry={onRetry} /> : null
            ) : rows.length === 0 ? (
              isOwn ? (
                /* The one screen a new person sees. It names the action, says
                   what it gets them, and offers the control — rather than
                   reporting that they have nothing. */
                <div className="firstrun">
                  <p className="firstrun-title">{copy.tree.noNotes}</p>
                  <p className="firstrun-why">{copy.tree.noNotesWhy}</p>
                  {onCreateFirst !== undefined && (
                    <button type="button" onClick={onCreateFirst}>
                      {copy.tree.noNotesAction}
                    </button>
                  )}
                </div>
              ) : (
                <p className="empty">{space ? copy.tree.spaceEmpty : copy.tree.nothingShared}</p>
              )
            ) : filter !== '' ? (
              hits.length === 0 ? (
                isOwn ? <p className="empty">{copy.tree.noMatch}</p> : null
              ) : (
                <ul className="tree tree-hits" role="none">
                  {hits.map((note) => noteRow(note, true, 1))}
                </ul>
              )
            ) : (
              <ul className="tree" role="none">
                {renderFolder(owner, buildTree(rows), 1)}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function countNotes(folder: Folder): number {
  return folder.notes.length + folder.folders.reduce((sum, child) => sum + countNotes(child), 0);
}

/**
 * Matched against the title and the path, so both "proxmox" and "homelab" find
 * `21_Homelab/Proxmox Cluster.md`. The path is matched with its prefixes
 * stripped as well, so typing what you *see* works.
 */
function matches(note: NoteRow, filter: string): boolean {
  const haystack = `${note.title}\u0000${note.path}\u0000${displayPath(note.path)}`.toLowerCase();
  return filter.split(/\s+/).every((word) => haystack.includes(word));
}
