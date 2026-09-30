/**
 * The live connection for the open note.
 *
 * One provider per (owner, path) and per generation. A rebase — the room was
 * recreated while this tab was away — is the one case the CRDT cannot settle
 * on its own: the text goes out through the ordinary save path with the last
 * hash the server acknowledged as its base, which is the three-way merge, and
 * then a fresh provider starts against the new room.
 */

import { useEffect, useRef, useState } from 'react';

import { api } from '../api';
import { CollabProvider, type CollabStatus } from './provider';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  self: boolean;
}

export interface CollabHandlers {
  onMoved(owner: string, path: string): void;
  onDeleted(by: string): void;
  onGone(): void;
}

export interface Collab {
  provider: CollabProvider | null;
  status: CollabStatus;
  peers: Peer[];
  canWrite: boolean;
  synced: boolean;
}

const NONE: Collab = { provider: null, status: 'unavailable', peers: [], canWrite: false, synced: false };

function peersOf(provider: CollabProvider): Peer[] {
  const out: Peer[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    const user = (state as { user?: { name?: string; color?: string } }).user;
    // The server fills the name in. An entry without one is a tab that has
    // announced a cursor and not yet been answered.
    if (user?.name === undefined || user.name === '') return;
    out.push({
      clientId,
      name: user.name,
      color: user.color ?? '#888888',
      self: clientId === provider.doc.clientID,
    });
  });
  return out;
}

export function useCollab(
  ref: { owner: string; path: string } | null,
  enabled: boolean,
  handlers: CollabHandlers,
): Collab {
  const [state, setState] = useState<Collab>(NONE);
  const [generation, setGeneration] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const owner = ref?.owner ?? null;
  const path = ref?.path ?? null;

  useEffect(() => {
    if (!enabled || owner === null || path === null) {
      setState(NONE);
      return;
    }

    const provider = new CollabProvider({ owner, path });
    // The server decides the name and the colour; this only gives the tab a
    // local state to hang its cursor on, so `y-codemirror.next` announces one.
    provider.awareness.setLocalStateField('user', { name: '' });

    const update = (): void =>
      setState({
        provider,
        status: provider.status,
        peers: peersOf(provider),
        canWrite: provider.canWrite,
        synced: provider.synced,
      });
    update();

    const offs = [
      provider.on('status', (status) => {
        update();
        if (status === 'gone') handlersRef.current.onGone();
        if (status === 'rebase') {
          const text = provider.text.toString();
          const base = provider.persistedHash ?? undefined;
          const owed = provider.dirtyOffline;
          // Nothing owed means the room simply restarted with the text it
          // already had; there is nothing to hand over, only a provider to
          // replace. What is owed goes through `putNote`, whose `baseHash` is
          // the last version the server acknowledged — a three-way merge, so
          // somebody else's work in the meantime is not overwritten.
          void (owed ? api.putNote(owner, path, text, base) : Promise.resolve())
            .catch(() => undefined)
            .finally(() => setGeneration((g) => g + 1));
        }
      }),
      provider.on('synced', update),
      provider.on('control', (control) => {
        update();
        if (control.type === 'moved') handlersRef.current.onMoved(control.owner, control.path);
        if (control.type === 'deleted') handlersRef.current.onDeleted(control.by);
      }),
    ];
    const onAwareness = (): void => update();
    provider.awareness.on('change', onAwareness);

    /**
     * Leaving the page with something unsent.
     *
     * Only while not live: what is live is already in the room, and the room
     * writes it out with or without this tab. What was typed offline has
     * reached nobody, so it goes out through the ordinary save with the last
     * acknowledged version as its base — `api.putNote` already sets
     * `keepalive` when the body fits the platform's budget.
     */
    const onLeave = (): void => {
      if (provider.status !== 'live' && provider.dirtyOffline) {
        void api
          .putNote(owner, path, provider.text.toString(), provider.persistedHash ?? undefined)
          .catch(() => undefined);
      }
    };
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);

    return () => {
      for (const off of offs) off();
      provider.awareness.off('change', onAwareness);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
      // Closing the note is leaving it, as far as unsent text is concerned.
      onLeave();
      provider.destroy();
    };
    // `generation` is what a rebase increments to build a fresh provider.
  }, [enabled, owner, path, generation]);

  return state;
}
