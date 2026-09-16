/**
 * What kind of note this is, for the card under the pointer.
 *
 * Only ever derived from the folder, because that is the only thing the graph
 * endpoint says about a note besides its links. A vault laid out the PARA way —
 * projects, areas, resources, maps — gets the names it uses for those; any other
 * vault gets its own top folder, tidied up. Nothing is invented: a folder this
 * does not recognise is shown as what it is called.
 *
 * The strings themselves are in `copy.ts`. This returns a key into them, so that
 * a translation never has to touch a rule about folders.
 */

export type NoteKind =
  | 'project'
  | 'client'
  | 'archived'
  | 'area'
  | 'resource'
  | 'map'
  | 'rules'
  | 'note'
  | 'folder';

export interface NoteKindResult {
  kind: NoteKind;
  /** For `folder`: the name to show, taken from the vault itself. */
  label: string;
}

/** Strips a sort prefix: `10_Projects` and `30 Resources` are both "Resources". */
function tidy(segment: string): string {
  const bare = segment.replace(/^\d+[_\-. ]*/, '').replace(/[_-]+/g, ' ').trim();
  return bare.length === 0 ? segment : bare;
}

export function noteKind(folder: string, title: string): NoteKindResult {
  const parts = folder.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return { kind: 'note', label: '' };
  const top = tidy(parts[0]!).toLowerCase();
  const second = parts.length > 1 ? tidy(parts[1]!).toLowerCase() : '';

  if (top.startsWith('project')) {
    if (second.includes('done') || second.includes('archiv')) return { kind: 'archived', label: '' };
    if (second.includes('kunden') || second.includes('client')) return { kind: 'client', label: '' };
    return { kind: 'project', label: '' };
  }
  if (top.startsWith('area')) return { kind: 'area', label: '' };
  if (top.startsWith('resource')) return { kind: 'resource', label: '' };
  if (top.startsWith('moc') || top.includes('map')) {
    return { kind: title.startsWith('_') ? 'rules' : 'map', label: '' };
  }
  return { kind: 'folder', label: tidy(parts[0]!) };
}
