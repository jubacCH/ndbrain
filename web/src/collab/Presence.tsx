/**
 * Who else is in this note, and whether the live connection holds.
 *
 * One mark per name: a person with two tabs open is one person here, even
 * though both of their cursors show in the text. Oneself is left out — the
 * caret in the note is already there.
 */

import { copy } from '../copy';
import type { CollabStatus } from './provider';
import type { Peer } from './useCollab';

const ROBOT = '🤖';

function initials(name: string): string {
  if (name.startsWith(ROBOT)) return ROBOT;
  return name
    .split(/\s+/)
    .filter((part) => part !== '')
    .map((part) => [...part][0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function labelFor(status: CollabStatus): string {
  if (status === 'live') return copy.collab.live;
  if (status === 'offline') return copy.collab.offline;
  return copy.collab.connecting;
}

export function Presence({ peers, status }: { peers: Peer[]; status: CollabStatus }): React.JSX.Element {
  const others = new Map<string, Peer>();
  for (const peer of peers) if (!peer.self && !others.has(peer.name)) others.set(peer.name, peer);

  return (
    <div className="presence" aria-live="polite">
      {[...others.values()].map((peer) => (
        <span key={peer.name} className="presence-mark" title={peer.name} style={{ background: peer.color }}>
          {initials(peer.name)}
        </span>
      ))}
      <span className={`presence-status presence-${status}`} role="status">
        {labelFor(status)}
      </span>
    </div>
  );
}
