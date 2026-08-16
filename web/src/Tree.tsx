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

import { useEffect, useMemo, useRef, useState } from 'react';
import { copy } from './copy';

import { refKey, type NoteRow, type Share } from './api';

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

const OPEN_KEY = 'ndbrain.openFolders';

function loadOpen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
  } catch {
    return new Set();
  }
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
function useTreeKeys(container: React.RefObject<HTMLDivElement | null>) {
  const rows = (): HTMLButtonElement[] =>
    [...(container.current?.querySelectorAll<HTMLButtonElement>('button.node') ?? [])];

  const move = (from: HTMLElement, delta: number): void => {
    const all = rows();
    const index = all.indexOf(from as HTMLButtonElement);
    const next = all[Math.min(all.length - 1, Math.max(0, index + delta))];
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
        // Otherwise walk up to the nearest row that is a shallower list level —
        // the parent folder, whatever the nesting depth happens to be.
        const all = rows();
        const index = all.indexOf(target as HTMLButtonElement);
        const depth = (el: HTMLElement): number => {
          let n = 0;
          for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'UL') n += 1;
          return n;
        };
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
}: TreeProps): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const onKeyDown = useTreeKeys(box);

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

    const foreign = [...byOwner.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, rows]) => ({ owner, rows }));

    return [{ owner: self, rows: own }, ...foreign];
  }, [notes, self]);

  // Which folders are *open*, not which are closed: the default has to survive
  // a vault growing a new folder, and an unknown folder should start shut.
  const [open, setOpen] = useState<Set<string>>(loadOpen);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
    } catch {
      // A vault that cannot remember which folders were open is still usable.
    }
  }, [open]);

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

  const toggle = (key: string): void => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const noteRow = (note: NoteRow, showPath: boolean): React.JSX.Element => {
    const key = refKey(note.owner, note.path);
    const finding = findings.get(key);
    const where = displayPath(note.path, hidePrefixes);
    return (
      <li key={`f:${key}`}>
        <button
          type="button"
          className={showPath ? 'node node-hit' : 'node'}
          tabIndex={seatOf()}
          aria-current={selected !== null && selected.owner === note.owner && selected.path === note.path}
          onClick={() => onSelect(note.owner, note.path)}
        >
          {finding !== undefined && <span className={`st st-${finding}`} />}
          {!showPath && <span className="tw" />}
          <span className="nm">{note.title}</span>
          {showPath && where !== '' && <span className="where">{where}</span>}
        </button>
      </li>
    );
  };

  const renderFolder = (owner: string, folder: Folder): React.JSX.Element[] => [
    ...folder.folders.map((child) => {
      const key = refKey(owner, child.path);
      const isOpen = open.has(key);
      const count = countNotes(child);
      return (
        <li key={`d:${key}`}>
          <div className="node-row">
            <button
              type="button"
              className="node"
              tabIndex={seatOf()}
              onClick={() => toggle(key)}
              aria-expanded={isOpen}
            >
              <span className="tw">{isOpen ? '▾' : '▸'}</span>
              <span className="nm">{displayName(child.name, hidePrefixes)}</span>
              {/* Shown only while shut: once it is open you can see them. */}
              {!isOpen && <span className="cnt">{count}</span>}
            </button>
            {owner === self && (
              <button
                type="button"
                className="node-act"
                title={copy.tree.renameFolder(displayName(child.name, hidePrefixes))}
                aria-label={copy.tree.renameFolderLabel(displayName(child.name, hidePrefixes))}
                onClick={() => onRenameFolder(child.path)}
              >
                ✎
              </button>
            )}
          </div>
          {isOpen && <ul>{renderFolder(owner, child)}</ul>}
        </li>
      );
    }),
    ...folder.notes.map((note) => noteRow(note, false)),
  ];

  /**
   * One tab stop for the whole tree.
   *
   * Every row was reachable by Tab before, which is the canonical hobby-tool
   * failure: sixty presses to get past the sidebar. Only the first row is in the
   * tab order now; the arrow keys do the rest.
   */
  let seat = 0;
  const seatOf = (): number => (seat++ === 0 ? 0 : -1);

  return (
    <div className="treebox" ref={box} onKeyDown={onKeyDown} role="tree" aria-label="Notes">
      {vaults.map(({ owner, rows }) => {
        const isOwn = owner === self;
        const hits =
          filter === '' ? [] : rows.filter((note) => matches(note, filter)).slice(0, 60);

        return (
          <section className="vault" key={owner} data-foreign={!isOwn}>
            {/*
              Your own vault carries no header at all. Labelling it "Julian" would
              make the single-user case — which is every case until somebody
              shares something — look like it has an owner problem.
            */}
            {!isOwn && (
              <h3 className="vault-head">
                <span className="vault-owner">{owner}</span>
                {/* Neutral, not coloured: the right is a fact about the folder,
                    not a finding. Colour in this interface always means
                    "something is wrong here" or "this is not yours", and the
                    header itself already carries the second. */}
                <span className="pill p-tag">{writeLabel(owner, received)}</span>
              </h3>
            )}

            {rows.length === 0 ? (
              <p className="empty">
                {isOwn ? copy.tree.noNotes : copy.tree.nothingShared}
              </p>
            ) : filter !== '' ? (
              hits.length === 0 ? (
                isOwn ? <p className="empty">{copy.tree.noMatch}</p> : null
              ) : (
                <ul className="tree tree-hits">{hits.map((note) => noteRow(note, true))}</ul>
              )
            ) : (
              <ul className="tree">{renderFolder(owner, buildTree(rows))}</ul>
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
  const haystack = `${note.title} ${note.path} ${displayPath(note.path)}`.toLowerCase();
  return filter.split(/\s+/).every((word) => haystack.includes(word));
}
