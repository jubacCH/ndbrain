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
 */

import { useMemo, useState } from 'react';

import { refKey, type NoteRow, type Share } from './api';

export type Finding = 'crit' | 'warn';

export interface TreeProps {
  notes: NoteRow[];
  /** The signed-in account, whose vault is shown first and without a header. */
  self: string;
  /** What has been shared *with* the caller — the source of the section labels. */
  received: Share[];
  selected: { owner: string; path: string } | null;
  findings: Map<string, Finding>;
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
  if (mine.length === 0 || mine.every((share) => !share.canWrite)) return 'nur lesen';
  if (mine.every((share) => share.canWrite)) return 'schreiben';
  return 'teils schreiben';
}

export function Tree({
  notes,
  self,
  received,
  selected,
  findings,
  onSelect,
  onRenameFolder,
}: TreeProps): React.JSX.Element {
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

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderFolder = (owner: string, folder: Folder): React.JSX.Element[] => {
    const open = !collapsed.has(refKey(owner, folder.path));

    return [
      ...folder.folders.map((child) => {
        const key = refKey(owner, child.path);
        return (
          <li key={`d:${key}`}>
            <div className="node-row">
              <button type="button" className="node" onClick={() => toggle(key)}>
                <span className="tw">{collapsed.has(key) ? '▸' : '▾'}</span>
                <span className="nm">{child.name}</span>
              </button>
              {owner === self && (
                <button
                  type="button"
                  className="node-act"
                  title={`„${child.name}" umbenennen oder verschieben`}
                  aria-label={`${child.name} umbenennen`}
                  onClick={() => onRenameFolder(child.path)}
                >
                  ✎
                </button>
              )}
            </div>
            {!collapsed.has(key) && <ul>{renderFolder(owner, child)}</ul>}
          </li>
        );
      }),
      ...(open
        ? folder.notes.map((note) => {
            const key = refKey(note.owner, note.path);
            const finding = findings.get(key);
            return (
              <li key={`f:${key}`}>
                <button
                  type="button"
                  className="node"
                  aria-current={selected !== null && selected.owner === note.owner && selected.path === note.path}
                  onClick={() => onSelect(note.owner, note.path)}
                >
                  {finding !== undefined && <span className={`st st-${finding}`} />}
                  <span className="tw" />
                  <span className="nm">{note.title}</span>
                </button>
              </li>
            );
          })
        : []),
    ];
  };

  return (
    <>
      {vaults.map(({ owner, rows }) => {
        const isOwn = owner === self;
        const root = buildTree(rows);

        return (
          <section className="vault" key={owner} data-foreign={!isOwn}>
            {/*
              Your own vault carries no header at all. Labelling it "Julian" would
              make the single-user case — which is every case until somebody
              shares something — look like it has an owner problem.
            */}
            {!isOwn && (
              <h3 className="vault-head">
                <span className="vault-owner mono">{owner}</span>
                {/* Neutral, not coloured: the right is a fact about the folder,
                    not a finding. Colour in this interface always means
                    "something is wrong here" or "this is not yours", and the
                    header itself already carries the second. */}
                <span className="pill p-tag">{writeLabel(owner, received)}</span>
              </h3>
            )}

            {rows.length === 0 ? (
              <p className="empty">
                {isOwn ? 'Noch keine Notizen. Leg mit „Neu" die erste an.' : 'Nichts freigegeben.'}
              </p>
            ) : (
              <ul className="tree">{renderFolder(owner, root)}</ul>
            )}
          </section>
        );
      })}
    </>
  );
}
