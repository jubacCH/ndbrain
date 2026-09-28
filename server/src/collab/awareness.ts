/**
 * Presence: who is in a note, where their cursor is, what they are called.
 *
 * The y-protocols awareness update is a list of (clientID, clock, JSON state).
 * The server rewrites it before anybody else sees it: a client may say where
 * its cursor is, never who it is. Name and colour come from the session, and
 * a connection may only speak for the client ids it claimed first.
 */

import { createHash } from 'node:crypto';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export interface Look {
  name: string;
  color: string;
  colorLight: string;
}

const PALETTE = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#60a5fa', '#fb7185', '#facc15'];
const ROBOT = '🤖';

function colourFor(seed: string): string {
  const byte = createHash('sha1').update(seed).digest()[0] ?? 0;
  return PALETTE[byte % PALETTE.length]!;
}

function look(name: string, seed: string): Look {
  const color = colourFor(seed);
  return { name, color, colorLight: `${color}33` };
}

/** A person: coloured by account, so one person's devices share a colour. */
export function personLook(id: string, displayName: string): Look {
  // The robot marks agents; a person naming themselves with it would pass as one.
  const name = displayName.replace(/^\s*🤖\s*/u, '').trim() || id;
  return look(name, `person:${id}`);
}

export function agentLook(keyName: string): Look {
  return look(`${ROBOT} ${keyName}`, `agent:${keyName}`);
}

interface Entry {
  clientID: number;
  clock: number;
  state: Record<string, unknown> | null;
}

function encode(entries: Entry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientID);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessState(
  clientID: number,
  clock: number,
  state: Record<string, unknown> | null,
): Uint8Array {
  return encode([{ clientID, clock, state }]);
}

export function sanitizeAwareness(
  update: Uint8Array,
  claim: (clientID: number) => boolean,
  who: Look,
): Uint8Array | null {
  const kept: Entry[] = [];
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    if (count > 16) return null;
    for (let i = 0; i < count; i++) {
      const clientID = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const raw: unknown = JSON.parse(decoding.readVarString(decoder));
      if (!claim(clientID)) continue;
      if (raw === null) {
        kept.push({ clientID, clock, state: null });
        continue;
      }
      if (typeof raw !== 'object' || Array.isArray(raw)) continue;
      kept.push({ clientID, clock, state: { ...(raw as Record<string, unknown>), user: who } });
    }
  } catch {
    return null;
  }
  return kept.length === 0 ? null : encode(kept);
}
