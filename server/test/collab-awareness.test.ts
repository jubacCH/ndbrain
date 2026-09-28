import { describe, expect, it } from 'vitest';
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

describe('looks', () => {
  it('gives one account the same colour everywhere', () => {
    expect(personLook('julian', 'Julian').color).toBe(personLook('julian', 'J.').color);
  });

  it('marks agents', () => {
    expect(agentLook('claude-code').name).toBe('🤖 claude-code');
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
    const removal = encodeAwarenessState(42, 3, null);
    const clean = sanitizeAwareness(removal, () => true, personLook('a', 'A'))!;
    expect(clean).not.toBeNull();
  });

  it('refuses the robot prefix from a person', () => {
    const look = personLook('mallory', '🤖 claude-code');
    expect(look.name.startsWith('🤖')).toBe(false);
  });

  it('refuses garbage', () => {
    expect(sanitizeAwareness(new Uint8Array([200, 1, 2]), () => true, personLook('a', 'A'))).toBeNull();
  });
});
