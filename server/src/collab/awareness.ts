/**
 * Presence: who is in a note, where their cursor is, what they are called.
 *
 * The y-protocols awareness update is a list of (clientID, clock, JSON state).
 * The server rewrites it before anybody else sees it: a client may say where
 * its cursor is, never who it is — the whole state is replaced by exactly
 * `{ cursor, user }`, with `user` the session's own look. A connection may
 * only speak for the client ids it claimed first, and it is only asked to
 * claim ids from an update that decoded and parsed cleanly in full: one
 * malformed entry invalidates the whole update before any id is claimed.
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
const MAX_ENTRIES = 16;
const MAX_STATE_CHARS = 16 * 1024;

function colourFor(seed: string): string {
  const byte = createHash('sha1').update(seed).digest()[0] ?? 0;
  return PALETTE[byte % PALETTE.length]!;
}

function look(name: string, seed: string): Look {
  const color = colourFor(seed);
  return { name, color, colorLight: `${color}33` };
}

/**
 * Removes every way of writing the robot marker: the emoji itself (with or
 * without the variation selector some clients append), anywhere in the
 * string, plus any invisible formatting character (zero-width space,
 * zero-width joiner, ...) that could otherwise hide next to it and defeat a
 * naive prefix strip. What is left is collapsed to single spaces and trimmed.
 */
function stripRobotClaim(displayName: string): string {
  const visible = displayName.replace(/\p{Cf}/gu, '');
  const withoutRobot = visible.replace(/🤖️?/gu, '');
  return withoutRobot.replace(/\s+/g, ' ').trim();
}

/** A person: coloured by account, so one person's devices share a colour. */
export function personLook(id: string, displayName: string): Look {
  // The robot marks agents; a person naming themselves with it would pass as one.
  const name = stripRobotClaim(displayName) || id;
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

interface Candidate {
  clientID: number;
  clock: number;
  raw: unknown;
  rawJson: string;
}

/**
 * Decodes every entry of a raw update, including parsing each entry's JSON
 * state. Fails closed: one malformed entry — a broken varint, an
 * unparseable JSON string — invalidates the whole update, before `claim`
 * has been asked about any of the client ids in it.
 */
function decodeCandidates(update: Uint8Array): Candidate[] | null {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    if (count > MAX_ENTRIES) return null;
    const candidates: Candidate[] = [];
    for (let i = 0; i < count; i++) {
      const clientID = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const rawJson = decoding.readVarString(decoder);
      const raw: unknown = JSON.parse(rawJson);
      candidates.push({ clientID, clock, raw, rawJson });
    }
    return candidates;
  } catch {
    return null;
  }
}

export function sanitizeAwareness(
  update: Uint8Array,
  claim: (clientID: number) => boolean,
  who: Look,
): Uint8Array | null {
  const candidates = decodeCandidates(update);
  if (candidates === null) return null;

  const kept: Entry[] = [];
  for (const { clientID, clock, raw, rawJson } of candidates) {
    if (!claim(clientID)) continue;
    if (raw === null) {
      kept.push({ clientID, clock, state: null });
      continue;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) continue;
    // A client may say where its cursor is; nothing else of what it sends survives.
    if (rawJson.length > MAX_STATE_CHARS) continue;
    const cursor = (raw as Record<string, unknown>)['cursor'] ?? null;
    kept.push({ clientID, clock, state: { cursor, user: who } });
  }
  return kept.length === 0 ? null : encode(kept);
}
