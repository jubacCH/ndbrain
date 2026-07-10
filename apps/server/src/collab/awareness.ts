import { Awareness, removeAwarenessStates } from "y-protocols/awareness";

/** Small, fixed palette so an actor's badge color is stable across writes and
 *  processes without needing to persist anything. */
const AGENT_COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];

/** Origin tag attached to the `change`/`update` events this module emits.
 *  Deliberately NOT a `ConnectionTransactionOrigin` (`{ source: "connection" }`)
 *  - `Document.handleAwarenessUpdate` (see `@hocuspocus/server`'s `Document.ts`)
 *  only special-cases that shape to track a state as belonging to a specific
 *  socket connection's client-id set. Anything else (this included) is still
 *  broadcast to every connection on the document exactly the same way - it's
 *  just not attributed to any one socket. */
const AGENT_AWARENESS_ORIGIN = { source: "agent-write" } as const;

/** FNV-1a: a small, dependency-free, deterministic string hash - good enough
 *  for picking a stable color/client-id per actor, not for anything
 *  security-sensitive. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic color for `actor`'s awareness badge, picked from a small
 *  fixed palette. */
export function agentAwarenessColor(actor: string): string {
  return AGENT_COLORS[hashString(actor) % AGENT_COLORS.length]!;
}

/**
 * Deterministic per-actor client id for the transient agent-awareness entry,
 * always NEGATIVE so it can never collide with a real Yjs client id (Yjs
 * generates `doc.clientID` as a non-negative 32-bit integer, see `yjs`'s
 * `Doc` constructor). Deterministic (not random) so re-applying/clearing the
 * same actor's state always targets the same map entry instead of leaking a
 * new one on every write.
 */
export function agentAwarenessClientId(actor: string): number {
  return -1 - (hashString(actor) % 0x7fffffff);
}

/**
 * Sets a transient `{ user: { name, agent: true, color } }` awareness state
 * for `actor` on the real Hocuspocus `Document.awareness` (a y-protocols
 * `Awareness` instance), broadcasting it to every connected client on that
 * document exactly like a genuine client awareness update would (both
 * listen on the same `awareness.on("update", ...)` event Hocuspocus's
 * `Document.handleAwarenessUpdate` subscribes to in its constructor).
 *
 * There is no built-in Hocuspocus/y-protocols API for setting a REMOTE
 * (non-local) client's awareness state from the server: `setLocalState`/
 * `setLocalStateField` only ever write `awareness.clientID` (this doc's own
 * id), and the wire-level `applyAwarenessUpdate` expects an update encoded
 * by a genuinely separate `Awareness` instance with its own independent
 * clock - looping an encode/decode round trip back onto the SAME instance
 * doesn't fit that model (a message can never be "newer than itself" against
 * its own clock). So this mutates `states`/`meta` directly and re-emits the
 * same `change`/`update` event shape y-protocols' own `applyAwarenessUpdate`
 * emits for an added/updated client (verified against the installed
 * `y-protocols@1.0.7` source) - the exact public contract `Document` (and
 * any real client's `Awareness` instance) listens for, not a fake/shadow
 * mechanism.
 */
export function setAgentAwarenessState(awareness: Awareness, actor: string): void {
  const clientId = agentAwarenessClientId(actor);
  const state = { user: { name: actor, agent: true, color: agentAwarenessColor(actor) } };
  const isNew = !awareness.states.has(clientId);
  const prevClock = awareness.meta.get(clientId)?.clock ?? -1;
  awareness.states.set(clientId, state);
  awareness.meta.set(clientId, { clock: prevClock + 1, lastUpdated: Date.now() });
  const changed = { added: isNew ? [clientId] : [], updated: isNew ? [] : [clientId], removed: [] };
  awareness.emit("change", [changed, AGENT_AWARENESS_ORIGIN]);
  awareness.emit("update", [changed, AGENT_AWARENESS_ORIGIN]);
}

/** Clears `actor`'s transient awareness state via y-protocols' own public
 *  `removeAwarenessStates` (the same function a real client/`Document` uses
 *  to mark a peer offline) - broadcasts the removal to every connection. */
export function clearAgentAwarenessState(awareness: Awareness, actor: string): void {
  removeAwarenessStates(awareness, [agentAwarenessClientId(actor)], AGENT_AWARENESS_ORIGIN);
}
