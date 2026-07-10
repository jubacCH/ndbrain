/** Pure helpers for turning Hocuspocus/Yjs awareness state into UI-friendly data.
 *
 *  `y-codemirror.next`'s `yCollab()` already renders the actual in-editor remote
 *  cursors/selections (its `yRemoteSelections` view plugin reads `state.user.name`
 *  /`state.user.color` off each awareness entry and draws a colored caret+label
 *  widget - verified against the installed package's `dist/src/y-remote-
 *  selections.js`). It does NOT know about the `agent: true` flag the server sets
 *  for an agent-originated write (`apps/server/src/collab/awareness.ts`'s
 *  `setAgentAwarenessState`) - its caret widget always renders the plain `name`
 *  with no way to hook in extra markup/styling short of forking that file. So
 *  this module adds the one thing yCollab's rendering can't: a distinct "<agent>
 *  is editing…" activity line (`Editor.tsx` renders it next to the editor,
 *  alongside yCollab's own in-text remote cursors).
 */

export interface AwarenessUser {
  name?: string;
  color?: string;
  agent?: boolean;
}

/** Structural shape of one entry in `Awareness.getStates()` - a loose bag of
 *  fields, of which only `user` matters here (y-codemirror.next itself also
 *  stores a transient `cursor` field on the same object, irrelevant to this
 *  module). */
export interface AwarenessStateLike {
  user?: AwarenessUser;
  [key: string]: unknown;
}

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  agent: boolean;
}

const DEFAULT_COLOR = "#8b93a1";
const DEFAULT_NAME = "Anonymous";

/** Maps a raw awareness states collection (`Awareness.getStates()`, a `Map<number,
 *  state>`, or any iterable of `[clientId, state]` pairs) into a peer list for
 *  display: the local client's own entry is dropped (it's not a "peer"), as is
 *  any state with no `user` field yet (a client that just connected and hasn't
 *  set its awareness field). */
export function peersFromAwarenessStates(
  states: Map<number, AwarenessStateLike> | Iterable<[number, AwarenessStateLike]>,
  localClientId?: number,
): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, state] of states) {
    if (clientId === localClientId) continue;
    if (!state?.user) continue;
    peers.push({
      clientId,
      name: state.user.name ?? DEFAULT_NAME,
      color: state.user.color ?? DEFAULT_COLOR,
      agent: state.user.agent === true,
    });
  }
  return peers;
}

/** A short "<agent(s)> is/are editing…" line for the agent peers in `peers`, or
 *  `null` if none are agents - the visible substitute for the in-editor agent
 *  badge yCollab's own cursor widget doesn't support (see module doc comment). */
export function agentActivityLabel(peers: Peer[]): string | null {
  const agents = peers.filter((peer) => peer.agent);
  if (agents.length === 0) return null;
  const names = agents.map((peer) => peer.name).join(", ");
  return agents.length === 1 ? `🤖 ${names} is editing…` : `🤖 ${names} are editing…`;
}

/** Small, fixed palette so a name's color is stable across sessions/devices
 *  without persisting anything - the same technique as the server's own
 *  `agentAwarenessColor` (`apps/server/src/collab/awareness.ts`), independently
 *  re-implemented here since the web bundle doesn't depend on the server package. */
const PALETTE = ["#e64980", "#f76707", "#f59f00", "#37b24d", "#1c7ed6", "#7048e8"];

/** FNV-1a: a small, dependency-free, deterministic string hash - good enough for
 *  picking a stable color per name, not for anything security-sensitive. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic color for the LOCAL user's own awareness badge, picked from a
 *  small fixed palette by name (see `Editor.tsx`, which sets `awareness.user =
 *  { name, color: colorForName(name) }` on connect). */
export function colorForName(name: string): string {
  return PALETTE[hashString(name) % PALETTE.length]!;
}
