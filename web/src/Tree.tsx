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
 */

import { useMemo, useState } from 'react';

import type { NoteRow } from './api';

export type Finding = 'crit' | 'warn';

export interface TreeProps {
  notes: NoteRow[];
  selected: string | null;
  findings: Map<string, Finding>;
  onSelect: (path: string) => void;
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

export function Tree({ notes, selected, findings, onSelect }: TreeProps): React.JSX.Element {
  const root = useMemo(() => buildTree(notes), [notes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderFolder = (folder: Folder): React.JSX.Element[] => {
    const open = !collapsed.has(folder.path);

    return [
      ...folder.folders.map((child) => (
        <li key={`d:${child.path}`}>
          <button type="button" className="node" onClick={() => toggle(child.path)}>
            <span className="tw">{collapsed.has(child.path) ? '▸' : '▾'}</span>
            <span className="nm">{child.name}</span>
          </button>
          {!collapsed.has(child.path) && <ul>{renderFolder(child)}</ul>}
        </li>
      )),
      ...(open
        ? folder.notes.map((note) => {
            const finding = findings.get(note.path);
            return (
              <li key={`f:${note.path}`}>
                <button
                  type="button"
                  className="node"
                  aria-current={note.path === selected}
                  onClick={() => onSelect(note.path)}
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

  if (notes.length === 0) {
    return <p className="empty">Noch keine Notizen. Leg mit „Neu" die erste an.</p>;
  }

  return <ul className="tree">{renderFolder(root)}</ul>;
}
