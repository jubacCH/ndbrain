import { describe, expect, it, vi } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';

import { agentLook, encodeAwarenessState, personLook, sanitizeAwareness } from '../src/collab/awareness.js';

function clientUpdate(state: Record<string, unknown>): { update: Uint8Array; clientID: number } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(state);
  return { update: encodeAwarenessUpdate(awareness, [doc.clientID]), clientID: doc.clientID };
}

function statesAfter(update: Uint8Array): Map<number, Record<string, unknown>> {
  const awareness = new Awareness(new Y.Doc());
  applyAwarenessUpdate(awareness, update, 'test');
  return awareness.getStates() as Map<number, Record<string, unknown>>;
}

/** Builds a raw awareness update with arbitrary, possibly-invalid per-entry JSON text. */
function rawUpdate(entries: Array<{ clientID: number; clock: number; rawJson: string }>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientID);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.rawJson);
  }
  return encoding.toUint8Array(encoder);
}

describe('looks', () => {
  it('gives one account the same colour everywhere', () => {
    expect(personLook('julian', 'Julian').color).toBe(personLook('julian', 'J.').color);
  });

  it('marks agents', () => {
    expect(agentLook('claude-code').name).toBe('🤖 claude-code');
  });

  it('strips the robot marker however it is hidden', () => {
    const cases = ['🤖🤖 claude-code', '🤖 🤖 claude-code', '​🤖 claude-code', '‍🤖x'];
    for (const displayName of cases) {
      expect(personLook('mallory', displayName).name).not.toContain('🤖');
    }
  });
});

describe('sanitizeAwareness', () => {
  it('overwrites the name a client claims', () => {
    const { update, clientID } = clientUpdate({ user: { name: 'Admin', color: '#000' }, cursor: null });
    const clean = sanitizeAwareness(update, () => true, personLook('ramona', 'Ramona'))!;
    const state = statesAfter(clean).get(clientID)!;
    expect((state['user'] as { name: string }).name).toBe('Ramona');
    expect(state['cursor']).toBeNull();
  });

  it('drops client ids the connection may not speak for', () => {
    const { update } = clientUpdate({ user: { name: 'x' } });
    expect(sanitizeAwareness(update, () => false, personLook('a', 'A'))).toBeNull();
  });

  it('passes a removal through', () => {
    const awareness = new Awareness(new Y.Doc());
    awareness.states.set(42, { user: { name: 'x' } });
    awareness.meta.set(42, { clock: 1, lastUpdated: 0 });

    const removal = encodeAwarenessState(42, 2, null);
    const clean = sanitizeAwareness(removal, () => true, personLook('a', 'A'))!;
    applyAwarenessUpdate(awareness, clean, 'test');

    expect(awareness.getStates().has(42)).toBe(false);
  });

  it('refuses the robot prefix from a person', () => {
    const look = personLook('mallory', '🤖 claude-code');
    expect(look.name.startsWith('🤖')).toBe(false);
  });

  it('refuses garbage', () => {
    expect(sanitizeAwareness(new Uint8Array([200, 1, 2]), () => true, personLook('a', 'A'))).toBeNull();
  });

  it('keeps only cursor and the server look, dropping anything else the client sent', () => {
    const who = personLook('a', 'A');
    const { update, clientID } = clientUpdate({
      user: { name: 'Admin' },
      cursor: { x: 1, y: 2 },
      agent: true,
      color: 'red',
    });
    const clean = sanitizeAwareness(update, () => true, who)!;
    const state = statesAfter(clean).get(clientID)!;

    expect(Object.keys(state).sort()).toEqual(['cursor', 'user']);
    expect(state['cursor']).toEqual({ x: 1, y: 2 });
    expect((state['user'] as { color: string }).color).toBe(who.color);
  });

  it('drops a state whose JSON is over 16 KiB', () => {
    const { update } = clientUpdate({ cursor: 'x'.repeat(20_000) });
    expect(sanitizeAwareness(update, () => true, personLook('a', 'A'))).toBeNull();
  });

  it('never claims any id when a later entry is garbage', () => {
    const update = rawUpdate([
      { clientID: 1, clock: 1, rawJson: JSON.stringify({ user: { name: 'ok' } }) },
      { clientID: 2, clock: 1, rawJson: 'not json' },
    ]);
    const claim = vi.fn(() => true);

    expect(sanitizeAwareness(update, claim, personLook('a', 'A'))).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it('keeps only the claimable id from a mixed update', () => {
    const update = rawUpdate([
      { clientID: 101, clock: 1, rawJson: JSON.stringify({ user: { name: 'a' } }) },
      { clientID: 202, clock: 1, rawJson: JSON.stringify({ user: { name: 'b' } }) },
    ]);
    const clean = sanitizeAwareness(update, (clientID) => clientID === 101, personLook('a', 'A'))!;
    const states = statesAfter(clean);

    expect(states.has(101)).toBe(true);
    expect(states.has(202)).toBe(false);
  });
});
