# Live Collaboration Implementation Plan

> **Executed. The checkboxes below were never ticked and never matched the branch** — they are
> left as written so this file still reads as the plan it was, not as a progress report. The code
> on `feat/live-collab` is the truth about what exists; the commit messages are the truth about
> where it departed from this plan, and `docs/superpowers/specs/2026-09-28-live-collab-design.md`
> names the three departures worth knowing. Do not read an empty box here as work outstanding.
>
> Two things in this plan do not work as written and were changed: the origin check cannot use
> `request.protocol` (it is `undefined` on a WebSocket upgrade, so the check as drafted refuses
> every connection), and the editor test in Task 9 imports an `undo` that `y-codemirror.next`
> does not export.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several people, one person's several tabs, and agents edit the same note at the same time, seeing each other's text, cursors and names live, while the `.md` file stays the only truth.

**Architecture:** While a note is open in at least one editor, the server keeps an in-memory Yjs room for it. Browsers sync with the room over a WebSocket (`y-protocols`); every other write path in `App` (REST, MCP, bulk actions, rename link rewrites, disk edits seen by the watcher) is routed into the room as either a transform of the live text or a three-way merge. The room persists to the file through the existing `NoteService` at most one second after the last change. No CRDT state is ever stored.

**Tech Stack:** Node 22+, Fastify 5, `@fastify/websocket`, `yjs`, `y-protocols`, `lib0`, `fast-diff`, `node-diff3`; React, CodeMirror 6, `y-codemirror.next`; vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-live-collab-design.md`

## Global Constraints

- No native dependency. Every new package must be pure JavaScript; `npm ls` must show no package with an `install`/`gyp` script added.
- Node 22 or newer; SQLite stays `node:sqlite`.
- Code comments and docstrings in English. UI copy in English (`web/test/one-language.test.ts` enforces it).
- Refusal looks like absence: any refused or missing note on the socket closes with the same code and reason (`4404`, `not found`).
- The `.md` file is the truth: no Yjs state is written to disk or to the database.
- Every change to note content goes through `App` → `NoteService`; nothing else writes to the vault.
- `NDBRAIN_COLLAB` (default `true`); `false` registers no socket route and every client runs in today's mode.
- Limits: incoming WebSocket message ≤ 8 MiB, 200 messages/s per socket (burst 400), 20 sockets per account, 200 open rooms per process.
- Persist delay 1000 ms; agent presence 5000 ms; permission backstop re-check every 60 000 ms.
- Before every commit: `npm test` and `npm run typecheck` in the package touched; `npm run smoke` in `server/` before the final commit of a server task.

## Review Focus

1. **Emoji, CRLF and NUL in note text** — a transform or merge must leave the file byte-identical to what the editors show. Test in Task 2 (`merge.test.ts`, property test with astral characters and `\r\n`).
2. **A laptop asleep for an hour while a note was open** — on wake the room has been recreated; the text must not be duplicated and offline typing must survive. Test in Task 8 (`collab-provider.test.ts`, "new epoch rebases instead of syncing").
3. **Two tabs of the same account** — both appear, same colour, and ⌘Z in one tab never undoes the other tab's typing. Test in Task 9 (`editor-collab.test.ts`, "undo only reverts local changes").
4. **Another person renames the note while I type** — typing continues into the moved note; nothing reappears at the old path. Test in Task 5 (`collab-structure.test.ts`, "rename while open keeps writing to the new path").
5. **A note bigger than the socket can carry** — the editor falls back to today's save path without losing text. Test in Task 8 (`collab-provider.test.ts`, "closes with 1009 fall back to unavailable").

---

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/collab.ts` (new) | Message type constants, close codes, `Control` zod schema — the wire contract both sides compile against. |
| `server/src/collab/merge.ts` (new) | Pure: `applyTextChange` (minimal char diff into a `Y.Text`), `threeWay` (line-based diff3). |
| `server/src/collab/awareness.ts` (new) | Pure: encode one awareness state, sanitize a client's awareness update, colours for people and agents. |
| `server/src/collab/room.ts` (new) | One open note: `Y.Doc`, peers, persist timer, `transform`, `merge`, disk sync, agent presence, control messages. |
| `server/src/collab/rooms.ts` (new) | Registry keyed by `owner:path`: open (deduplicated), get, rekey, limit, close-all. |
| `server/src/collab/socket.ts` (new) | The `/api/v1/collab` route: origin check, permission, protocol, limits, permission re-checks. |
| `server/src/app.ts` (modify) | Route content writes into a room when one is open; persist entry point for rooms; rename/delete hooks. |
| `server/src/notes/service.ts` (modify) | `writeConflictCopy` extracted from `#preserveDisplaced`. |
| `server/src/markdown/edit.ts` (modify) | Pure `replaceOnce` for MCP `edit_note`. |
| `server/src/mcp/tools.ts` (modify) | `edit_note` and `append_note` mark themselves as agent writes and use `App.editNote`. |
| `server/src/auth/shares.ts`, `server/src/auth/users.ts` (modify) | `onChange` listeners fired by every mutation that can change access. |
| `server/src/config.ts`, `server/src/runtime.ts`, `server/src/main.ts`, `server/src/http/server.ts` (modify) | Flag, wiring, route registration, shutdown flush. |
| `web/src/collab/provider.ts` (new) | Browser side of the protocol, reconnect, epoch check. |
| `web/src/collab/useCollab.ts` (new) | Hook: provider lifecycle for the open note, peers, status, rebase and unload. |
| `web/src/collab/Presence.tsx` (new) | Initials of who is present, and the live/offline indicator. |
| `web/src/Editor.tsx` (modify) | Optional `collab` prop: `yCollab` + `Y.UndoManager` instead of `history()`. |
| `web/src/App.tsx`, `web/src/copy.ts`, `web/vite.config.ts` (modify) | Wiring, copy, dev proxy for WebSocket. |

---

### Task 1: Dependencies, flag, wire contract

**Files:**
- Modify: `server/package.json`, `web/package.json` (via npm)
- Modify: `server/src/config.ts`
- Create: `shared/collab.ts`
- Modify: `docs/superpowers/specs/2026-09-28-live-collab-design.md` (library and limit amendments)
- Test: `server/test/collab-config.test.ts`

**Interfaces:**
- Produces: `Config.collab: boolean`; from `shared/collab.ts`: `MESSAGE_SYNC = 0`, `MESSAGE_AWARENESS = 1`, `MESSAGE_CONTROL = 2`, `CLOSE` (`gone: 4404`, `deleted: 4410`, `origin: 4403`, `limit: 4429`, `full: 4503`), `Control` (zod schema and type), `COLLAB_PATH = '/api/v1/collab'`.

- [ ] **Step 1: Install dependencies**

```bash
cd server && npm install yjs y-protocols lib0 @fastify/websocket fast-diff node-diff3 && npm install -D @types/ws
cd ../web && npm install yjs y-protocols lib0 y-codemirror.next
```

Check that nothing native came in:

```bash
cd server && npm ls --all --parseable | xargs -I{} sh -c 'test -f {}/binding.gyp && echo NATIVE {}' ; echo done
```

Expected: only `done` (the optional `bufferutil`/`utf-8-validate` of `ws` are not installed by default).

- [ ] **Step 2: Write the failing config test**

```ts
// server/test/collab-config.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('NDBRAIN_COLLAB', () => {
  afterEach(() => {
    delete process.env['NDBRAIN_COLLAB'];
  });

  it('is on when unset', () => {
    expect(loadConfig().collab).toBe(true);
  });

  it('can be switched off', () => {
    process.env['NDBRAIN_COLLAB'] = 'false';
    expect(loadConfig().collab).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd server && npx vitest run test/collab-config.test.ts`
Expected: FAIL, `collab` is `undefined`.

- [ ] **Step 4: Add the flag**

In `server/src/config.ts`, add to `Config` after `reconcileIntervalMs`:

```ts
  /**
   * Live collaboration over a WebSocket. Off means no socket route at all and
   * every browser saves the way it did before — the way back if something
   * about the live path misbehaves, without rolling back code.
   */
  collab: boolean;
```

and in `loadConfig` after `reconcileIntervalMs`:

```ts
    collab: envBool('NDBRAIN_COLLAB', true),
```

- [ ] **Step 5: Create the wire contract**

```ts
// shared/collab.ts
/**
 * The live-collaboration wire contract.
 *
 * Binary frames, each starting with a varUint message type. Sync and awareness
 * are the y-protocols formats unchanged; control carries one JSON object as a
 * varString, validated against `Control` on arrival.
 */

import { z } from 'zod';

export const COLLAB_PATH = '/api/v1/collab';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_CONTROL = 2;

/** Close codes. `gone` is used for "missing" and "not allowed" alike. */
export const CLOSE = {
  gone: 4404,
  deleted: 4410,
  origin: 4403,
  limit: 4429,
  full: 4503,
} as const;

export const Control = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    epoch: z.string(),
    canWrite: z.boolean(),
    persistedHash: z.string(),
  }),
  z.object({ type: z.literal('persisted'), hash: z.string() }),
  z.object({ type: z.literal('moved'), owner: z.string(), path: z.string() }),
  z.object({ type: z.literal('deleted'), by: z.string() }),
  z.object({ type: z.literal('access'), canWrite: z.boolean() }),
]);
export type Control = z.infer<typeof Control>;
```

- [ ] **Step 6: Amend the spec**

In the spec, replace `diff-match-patch` by `fast-diff` (character diff into Yjs) and `node-diff3` (three-way merge) in "Three-way merge", "New dependencies" and "Server units"; replace "message size 1 MiB" by "message size 8 MiB (a large note's first sync must fit)"; in "Structural changes", replace "persist is skipped" by "the room persists once more first, so *Recently deleted* holds the last text". Add one sentence to "Three-way merge": "diff3 recognises the same change made on both sides, which a patch applier would insert twice."

- [ ] **Step 7: Run tests and typecheck**

Run: `cd server && npx vitest run test/collab-config.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json web/package.json web/package-lock.json server/src/config.ts shared/collab.ts server/test/collab-config.test.ts docs/superpowers/specs/2026-09-28-live-collab-design.md
git commit -m "feat(collab): dependencies, NDBRAIN_COLLAB and the wire contract"
```

---

### Task 2: Text diff into Yjs and three-way merge

**Files:**
- Create: `server/src/collab/merge.ts`
- Test: `server/test/collab-merge.test.ts`

**Interfaces:**
- Produces:
  - `applyTextChange(text: Y.Text, from: string, to: string): number | null` — applies the minimal diff; must be called inside a `doc.transact`; returns the index just after the last change, `null` if nothing changed.
  - `threeWay(base: string, incoming: string, live: string): { text: string; clean: boolean }` — line-based; non-conflicting changes from both sides merged; for a conflicting block the live side is kept and `clean` is `false`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/collab-merge.test.ts
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { applyTextChange, threeWay } from '../src/collab/merge.js';

function textOf(initial: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, initial);
  return { doc, text };
}

describe('applyTextChange', () => {
  it.each([
    ['', 'hello'],
    ['hello', ''],
    ['Hallo Welt', 'Hallo liebe Welt'],
    ['a\r\nb\r\nc', 'a\r\nB\r\nc\r\nd'],
    ['emoji 🧠 here', 'emoji 🧠🧠 there'],
    ['👩‍👩‍👧 family', '👩‍👩‍👦 family'],
    ['nul\u0000byte', 'nul\u0000\u0000byte'],
  ])('turns %j into %j exactly', (from, to) => {
    const { doc, text } = textOf(from);
    doc.transact(() => applyTextChange(text, from, to));
    expect(text.toString()).toBe(to);
  });

  it('returns null when nothing changed', () => {
    const { doc, text } = textOf('same');
    let at: number | null = 0;
    doc.transact(() => {
      at = applyTextChange(text, 'same', 'same');
    });
    expect(at).toBeNull();
  });

  it('reports where the last change ended', () => {
    const { doc, text } = textOf('abc');
    let at: number | null = null;
    doc.transact(() => {
      at = applyTextChange(text, 'abc', 'abXc');
    });
    expect(at).toBe(3);
  });

  it('keeps a concurrent insert elsewhere in the text', () => {
    const a = textOf('one\ntwo\nthree\n');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const bText = b.getText('content');

    a.doc.transact(() => applyTextChange(a.text, 'one\ntwo\nthree\n', 'ONE\ntwo\nthree\n'));
    b.transact(() => bText.insert(bText.length, 'four\n'));

    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    expect(a.text.toString()).toBe('ONE\ntwo\nthree\nfour\n');
    expect(bText.toString()).toBe(a.text.toString());
  });

  it('is exact for random pairs, astral characters and CRLF included', () => {
    const alphabet = ['a', 'b', ' ', '\n', '\r\n', '🧠', 'é', '\u0000', '[[', ']]'];
    const random = (n: number): string =>
      Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    for (let i = 0; i < 300; i++) {
      const from = random(Math.floor(Math.random() * 40));
      const to = random(Math.floor(Math.random() * 40));
      const { doc, text } = textOf(from);
      doc.transact(() => applyTextChange(text, from, to));
      expect(text.toString()).toBe(to);
    }
  });
});

describe('threeWay', () => {
  it('merges changes on different lines', () => {
    const base = 'a\nb\nc\n';
    expect(threeWay(base, 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ text: 'A\nb\nC\n', clean: true });
  });

  it('treats the same change on both sides as one', () => {
    const base = 'a\nb\n';
    expect(threeWay(base, 'a\nB\n', 'a\nB\n')).toEqual({ text: 'a\nB\n', clean: true });
  });

  it('keeps the live side of a conflict and says so', () => {
    const base = 'a\nb\n';
    expect(threeWay(base, 'a\nX\n', 'a\nY\n')).toEqual({ text: 'a\nY\n', clean: false });
  });

  it('handles a text without a trailing newline', () => {
    expect(threeWay('a\nb', 'a\nb\nc', 'z\na\nb')).toEqual({ text: 'z\na\nb\nc', clean: true });
  });

  it('leaves live untouched when incoming equals base', () => {
    expect(threeWay('a\n', 'a\n', 'a\nlive\n')).toEqual({ text: 'a\nlive\n', clean: true });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run test/collab-merge.test.ts`
Expected: FAIL, cannot resolve `../src/collab/merge.js`.

- [ ] **Step 3: Implement**

```ts
// server/src/collab/merge.ts
/**
 * Text changes as Yjs operations, and merging a stale writer into live text.
 *
 * Pure: no I/O and no room state, so every rule about bytes can be tested with
 * nothing but strings.
 *
 * `fast-diff` works in UTF-16 code units, which is also what `Y.Text` counts
 * in, so an index from one is an index in the other. It keeps surrogate pairs
 * together, which is what the astral-character cases in the tests pin.
 */

import diff from 'fast-diff';
import { diff3Merge } from 'node-diff3';
import type * as Y from 'yjs';

/**
 * Applies the smallest set of inserts and deletes that turns `from` into `to`.
 *
 * Several small operations rather than one replacement of the changed middle:
 * a remote cursor sitting between two edited places stays where it was, and a
 * concurrent insert elsewhere merges instead of being overwritten.
 *
 * Must run inside a transaction, and `text` must hold exactly `from`.
 */
export function applyTextChange(text: Y.Text, from: string, to: string): number | null {
  if (from === to) return null;

  let index = 0;
  let last: number | null = null;
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) {
      index += chunk.length;
    } else if (op === diff.DELETE) {
      text.delete(index, chunk.length);
      last = index;
    } else {
      text.insert(index, chunk);
      index += chunk.length;
      last = index;
    }
  }
  return last;
}

/** Lines with their line endings kept, so joining gives back the exact text. */
function lines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

/**
 * Merges what a stale writer changed (base → incoming) into the live text.
 *
 * Line-based diff3. The same change made on both sides is one change, not two;
 * a block both sides changed differently keeps the live side, because that is
 * what everybody in the room is looking at, and reports `clean: false` so the
 * caller can keep the incoming text as a conflict copy.
 */
export function threeWay(base: string, incoming: string, live: string): { text: string; clean: boolean } {
  if (incoming === base || incoming === live) return { text: live, clean: true };
  if (live === base) return { text: incoming, clean: true };

  let clean = true;
  const out: string[] = [];
  for (const block of diff3Merge(lines(incoming), lines(base), lines(live))) {
    if ('ok' in block && block.ok !== undefined) {
      out.push(...block.ok);
    } else if ('conflict' in block && block.conflict !== undefined) {
      clean = false;
      out.push(...block.conflict.b);
    }
  }
  return { text: out.join(''), clean };
}
```

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run test/collab-merge.test.ts`
Expected: PASS. If `node-diff3`'s block shape differs (check `node_modules/node-diff3/index.d.ts`), adapt only the two property accesses; the tests define the behaviour.

A missing trailing newline on the last line makes `b\n` and `b` different lines. If the "trailing newline" case fails, normalise by appending `\n` to all three inputs when any lacks it and stripping it from the result when `live` lacked it; keep the test as written.

- [ ] **Step 5: Typecheck and commit**

```bash
cd server && npm run typecheck
git add server/src/collab/merge.ts server/test/collab-merge.test.ts
git commit -m "feat(collab): minimal text diff into Yjs and a diff3 merge"
```

---

### Task 3: Awareness helpers

**Files:**
- Create: `server/src/collab/awareness.ts`
- Test: `server/test/collab-awareness.test.ts`

**Interfaces:**
- Produces:
  - `interface Look { name: string; color: string; colorLight: string }`
  - `personLook(id: string, displayName: string): Look` — colour derived from the account id only.
  - `agentLook(keyName: string): Look` — name `🤖 <keyName>`.
  - `encodeAwarenessState(clientID: number, clock: number, state: Record<string, unknown> | null): Uint8Array`
  - `sanitizeAwareness(update: Uint8Array, claim: (clientID: number) => boolean, look: Look): Uint8Array | null` — drops entries whose clientID `claim` refuses, overwrites `state.user` with `look`; `null` if nothing remains.

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/collab-awareness.test.ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run test/collab-awareness.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/collab/awareness.ts
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
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
cd server && npx vitest run test/collab-awareness.test.ts && npm run typecheck
git add server/src/collab/awareness.ts server/test/collab-awareness.test.ts
git commit -m "feat(collab): awareness looks and sanitising"
```

---

### Task 4: Room and registry

**Files:**
- Create: `server/src/collab/room.ts`, `server/src/collab/rooms.ts`
- Test: `server/test/collab-room.test.ts`

**Interfaces:**
- Consumes: `applyTextChange`, `threeWay` (Task 2); `agentLook`, `encodeAwarenessState` (Task 3); `Control`, `MESSAGE_*`, `CLOSE` (Task 1); `contentHash` from `server/src/auth/noteBindings.ts`; `NoteNotFoundError` from `server/src/errors.ts`; `noteTitle` from `server/src/vault/paths.ts`; `Note` from `server/src/notes/service.ts`.
- Produces:
  - `interface Persisted { text: string; hash: string }`
  - `interface By { actor: string; agent?: boolean }`
  - `interface Peer { readonly userId: string; canWrite: boolean; readonly clientIds: Set<number>; send(message: Uint8Array): void; close(code: number, reason: string): void }`
  - `interface RoomDeps { persist(owner: string, path: string, text: string, baseHash: string, actors: string[]): Promise<Persisted>; readDisk(owner: string, path: string): Promise<Persisted | null>; conflictCopy(owner: string, path: string, text: string, actor: string): Promise<string>; onClosed(room: Room): void; persistDelayMs?: number; agentPresenceMs?: number; log?(error: unknown): void }`
  - `class Room` with `owner`, `path`, `epoch`, `doc`, `text`, `awareness`, `peers: Set<Peer>`, `lastPersisted: Persisted`, `closed: boolean`, and methods `transform(fn: (live: string) => string, by: By): void`, `merge(base: string, incoming: string, by: By): Promise<{ conflictCopy?: string }>`, `keepAsConflict(incoming: string, by: By): Promise<{ conflictCopy: string }>`, `note(): Note`, `flush(): Promise<void>`, `join(peer: Peer): void`, `leave(peer: Peer): Promise<void>`, `control(message: Control, only?: Peer): void`, `rekey(path: string): void`, `closeDeleted(by: string): void`, `destroy(): void`.
  - `class RoomRegistry` with `constructor(deps: RegistryDeps)`, `get(owner: string, path: string): Room | undefined`, `open(owner: string, path: string): Promise<Room>`, `rekey(owner: string, from: string, to: string): void`, `all(): Room[]`, `size: number`, `closeAll(): Promise<void>`; `interface RegistryDeps extends Omit<RoomDeps, 'onClosed'> { load(owner: string, path: string): Promise<Persisted>; maxRooms?: number }`; `class RoomLimitError extends Error`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/collab-room.test.ts
import { describe, expect, it, vi } from 'vitest';

import { contentHash } from '../src/auth/noteBindings.js';
import { Room, type Peer, type Persisted, type RoomDeps } from '../src/collab/room.js';
import { RoomLimitError, RoomRegistry } from '../src/collab/rooms.js';
import { NoteNotFoundError } from '../src/errors.js';

function disk(initial: string) {
  let file: Persisted | null = { text: initial, hash: contentHash(initial) };
  const writes: Array<{ text: string; baseHash: string; actors: string[] }> = [];
  const copies: string[] = [];
  const deps: RoomDeps = {
    persist: async (_o, _p, text, baseHash, actors) => {
      if (file === null) throw new NoteNotFoundError('gone');
      writes.push({ text, baseHash, actors });
      file = { text, hash: contentHash(text) };
      return file;
    },
    readDisk: async () => file,
    conflictCopy: async (_o, path, text) => {
      copies.push(text);
      return path.replace(/\.md$/, ' (Konflikt).md');
    },
    onClosed: () => undefined,
    persistDelayMs: 10,
    agentPresenceMs: 20,
  };
  return {
    deps,
    writes,
    copies,
    setFile: (text: string | null) => {
      file = text === null ? null : { text, hash: contentHash(text) };
    },
    file: () => file,
  };
}

function peer(userId = 'julian'): Peer & { sent: Uint8Array[]; closedWith?: number } {
  const p = {
    userId,
    canWrite: true,
    clientIds: new Set<number>(),
    sent: [] as Uint8Array[],
    closedWith: undefined as number | undefined,
    send(message: Uint8Array) {
      p.sent.push(message);
    },
    close(code: number) {
      p.closedWith = code;
    },
  };
  return p;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Room', () => {
  it('transforms the live text and persists it once, later', async () => {
    const d = disk('a\n');
    const room = new Room('julian', 'N.md', { text: 'a\n', hash: contentHash('a\n') }, d.deps);
    room.join(peer());
    room.transform((live) => `${live}b\n`, { actor: 'julian' });
    room.transform((live) => `${live}c\n`, { actor: 'ramona' });
    expect(room.text.toString()).toBe('a\nb\nc\n');
    expect(d.writes).toHaveLength(0);
    await wait(40);
    expect(d.writes).toHaveLength(1);
    expect(d.writes[0]!.text).toBe('a\nb\nc\n');
    expect(d.writes[0]!.actors.sort()).toEqual(['julian', 'ramona']);
  });

  it('leaves the text alone when the transform throws', () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    expect(() =>
      room.transform(() => {
        throw new Error('refused');
      }, { actor: 'julian' }),
    ).toThrow('refused');
    expect(room.text.toString()).toBe('x');
  });

  it('merges a stale writer and keeps a conflicting one as a copy', async () => {
    const d = disk('a\nb\n');
    const room = new Room('julian', 'N.md', { text: 'a\nb\n', hash: contentHash('a\nb\n') }, d.deps);
    room.transform(() => 'a\nB\n', { actor: 'julian' });

    expect(await room.merge('a\nb\n', 'A\nb\n', { actor: 'agent', agent: true })).toEqual({});
    expect(room.text.toString()).toBe('A\nB\n');

    const result = await room.merge('A\nB\n', 'A\nX\n', { actor: 'ramona' });
    expect(result.conflictCopy).toBe('N (Konflikt).md');
    expect(room.text.toString()).toBe('A\nB\n');
    expect(d.copies).toEqual(['A\nX\n']);
  });

  it('merges a change made on disk before it persists', async () => {
    const d = disk('one\ntwo\n');
    const room = new Room('julian', 'N.md', { text: 'one\ntwo\n', hash: contentHash('one\ntwo\n') }, d.deps);
    room.join(peer());
    room.transform(() => 'ONE\ntwo\n', { actor: 'julian' });
    d.setFile('one\ntwo\nthree\n');
    await room.flush();
    expect(room.text.toString()).toBe('ONE\ntwo\nthree\n');
    expect(d.file()!.text).toBe('ONE\ntwo\nthree\n');
  });

  it('closes as deleted when the file is gone', async () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    const p = peer();
    room.join(p);
    room.transform(() => 'y', { actor: 'julian' });
    d.setFile(null);
    await room.flush();
    expect(room.closed).toBe(true);
    expect(p.closedWith).toBe(4410);
  });

  it('shows an agent write as presence for a while', async () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    room.transform((live) => `${live} from agent`, { actor: 'claude-code', agent: true });
    const names = [...room.awareness.getStates().values()].map((s) => (s['user'] as { name: string }).name);
    expect(names).toContain('🤖 claude-code');
    await wait(60);
    expect(room.awareness.getStates().size).toBe(0);
  });

  it('persists and closes when the last peer leaves', async () => {
    const d = disk('x');
    const closed = vi.fn();
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, { ...d.deps, onClosed: closed, persistDelayMs: 10_000 });
    const p = peer();
    room.join(p);
    room.transform(() => 'y', { actor: 'julian' });
    await room.leave(p);
    expect(d.file()!.text).toBe('y');
    expect(closed).toHaveBeenCalledWith(room);
  });

  it('broadcasts updates to every peer but the one that sent them', () => {
    const d = disk('x');
    const room = new Room('julian', 'N.md', { text: 'x', hash: contentHash('x') }, d.deps);
    const a = peer('a');
    const b = peer('b');
    room.join(a);
    room.join(b);
    const before = { a: a.sent.length, b: b.sent.length };
    room.doc.transact(() => room.text.insert(0, '!'), a);
    expect(a.sent.length).toBe(before.a);
    expect(b.sent.length).toBe(before.b + 1);
  });
});

describe('RoomRegistry', () => {
  function registry(maxRooms = 200) {
    const d = disk('text');
    const load = vi.fn(async () => ({ text: 'text', hash: contentHash('text') }));
    return { reg: new RoomRegistry({ ...d.deps, load, maxRooms }), load };
  }

  it('opens one room per note even when asked twice at once', async () => {
    const { reg, load } = registry();
    const [a, b] = await Promise.all([reg.open('julian', 'N.md'), reg.open('julian', 'N.md')]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refuses beyond the limit', async () => {
    const { reg } = registry(1);
    await reg.open('julian', 'A.md');
    await expect(reg.open('julian', 'B.md')).rejects.toBeInstanceOf(RoomLimitError);
  });

  it('moves a room to its new path and tells its peers', async () => {
    const { reg } = registry();
    const room = await reg.open('julian', 'A.md');
    const p = peer();
    room.join(p);
    reg.rekey('julian', 'A.md', 'Ordner/B.md');
    expect(reg.get('julian', 'A.md')).toBeUndefined();
    expect(reg.get('julian', 'Ordner/B.md')).toBe(room);
    expect(room.path).toBe('Ordner/B.md');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run test/collab-room.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `room.ts`**

```ts
// server/src/collab/room.ts
/**
 * One note while somebody has it open.
 *
 * The Y.Doc here is a working copy in memory, never a store: it is filled from
 * the file when the room opens, written back to the file through the ordinary
 * write path at most `persistDelayMs` after the last change, and thrown away
 * when the last editor leaves. The file stays the truth.
 *
 * Every change to the text has exactly one way in, `transform`, which runs a
 * function on the live text and applies the difference. Because the difference
 * is computed against the live text at that instant, it is exact — there is no
 * guessing about what a writer meant, only about stale writers, which is what
 * `merge` is for.
 */

import { randomUUID } from 'node:crypto';

import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { CLOSE, MESSAGE_AWARENESS, MESSAGE_CONTROL, MESSAGE_SYNC, type Control } from '../../../shared/collab.js';
import { contentHash } from '../auth/noteBindings.js';
import { NoteNotFoundError } from '../errors.js';
import type { Note } from '../notes/service.js';
import { noteTitle } from '../vault/paths.js';
import { agentLook, encodeAwarenessState } from './awareness.js';
import { applyTextChange, threeWay } from './merge.js';

export interface Persisted {
  text: string;
  hash: string;
}

/** Who caused a change: an account id, or an agent key's name. */
export interface By {
  actor: string;
  agent?: boolean;
}

/** One connected editor, as the room sees it. */
export interface Peer {
  readonly userId: string;
  canWrite: boolean;
  readonly clientIds: Set<number>;
  send(message: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface RoomDeps {
  persist(owner: string, path: string, text: string, baseHash: string, actors: string[]): Promise<Persisted>;
  readDisk(owner: string, path: string): Promise<Persisted | null>;
  conflictCopy(owner: string, path: string, text: string, actor: string): Promise<string>;
  onClosed(room: Room): void;
  persistDelayMs?: number;
  agentPresenceMs?: number;
  log?(error: unknown): void;
}

export function encodeControl(message: Control): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CONTROL);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Origin of changes the server makes on nobody's behalf in particular. */
const SERVER = Symbol('server');

interface AgentPresence {
  clientID: number;
  clock: number;
  timer: NodeJS.Timeout;
}

export class Room {
  readonly epoch = randomUUID();
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: Awareness;
  readonly peers = new Set<Peer>();
  owner: string;
  path: string;
  lastPersisted: Persisted;
  closed = false;

  readonly #deps: RoomDeps;
  readonly #actors = new Set<string>();
  readonly #agents = new Map<string, AgentPresence>();
  #timer: NodeJS.Timeout | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(owner: string, path: string, initial: Persisted, deps: RoomDeps) {
    this.owner = owner;
    this.path = path;
    this.lastPersisted = initial;
    this.#deps = deps;
    this.text = this.doc.getText('content');
    this.doc.transact(() => this.text.insert(0, initial.text), SERVER);

    this.awareness = new Awareness(this.doc);
    // The server has no cursor of its own.
    this.awareness.setLocalState(null);

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (this.closed) return;
      const message = encodeSyncUpdate(update);
      for (const peer of this.peers) if (peer !== origin) peer.send(message);
      if (origin === SERVER) return;
      const actor = actorOf(origin);
      if (actor !== null) this.#actors.add(actor);
      this.#schedule();
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0 || this.closed) return;
        const message = encodeAwareness(encodeAwarenessUpdate(this.awareness, changed));
        for (const peer of this.peers) peer.send(message);
      },
    );
  }

  /** The live text as a note, for callers that answer with one. */
  note(): Note {
    const content = this.text.toString();
    return {
      path: this.path,
      title: noteTitle(this.path),
      content,
      size: Buffer.byteLength(content, 'utf8'),
      mtimeMs: Date.now(),
      hash: contentHash(content),
    };
  }

  /**
   * Runs `fn` on the live text and applies the difference.
   *
   * `fn` may throw to refuse (a task that moved, a text that is not there);
   * the text is then untouched, because nothing is applied before it returns.
   */
  transform(fn: (live: string) => string, by: By): void {
    if (this.closed) throw new NoteNotFoundError('note does not exist');
    const live = this.text.toString();
    const next = fn(live);
    if (next === live) return;
    let at: number | null = null;
    this.doc.transact(() => {
      at = applyTextChange(this.text, live, next);
    }, by);
    if (by.agent === true && at !== null) this.#showAgent(by.actor, at);
  }

  /** Merges a writer who started from `base`; see `threeWay`. */
  async merge(base: string, incoming: string, by: By): Promise<{ conflictCopy?: string }> {
    const live = this.text.toString();
    const { text, clean } = threeWay(base, incoming, live);
    if (text !== live) this.transform(() => text, by);
    if (clean) return {};
    return { conflictCopy: await this.#deps.conflictCopy(this.owner, this.path, incoming, by.actor) };
  }

  /** A writer whose starting point is unknown: kept beside the note, never merged. */
  async keepAsConflict(incoming: string, by: By): Promise<{ conflictCopy: string }> {
    return { conflictCopy: await this.#deps.conflictCopy(this.owner, this.path, incoming, by.actor) };
  }

  join(peer: Peer): void {
    this.peers.add(peer);
  }

  async leave(peer: Peer): Promise<void> {
    if (!this.peers.delete(peer)) return;
    removeAwarenessStates(this.awareness, [...peer.clientIds], SERVER);
    if (this.peers.size > 0) return;
    await this.flush();
    if (this.peers.size === 0 && !this.closed) this.destroy();
  }

  control(message: Control, only?: Peer): void {
    const bytes = encodeControl(message);
    if (only !== undefined) only.send(bytes);
    else for (const peer of this.peers) peer.send(bytes);
  }

  rekey(path: string): void {
    this.path = path;
    this.control({ type: 'moved', owner: this.owner, path });
  }

  closeDeleted(by: string): void {
    if (this.closed) return;
    this.control({ type: 'deleted', by });
    for (const peer of this.peers) peer.close(CLOSE.deleted, 'deleted');
    this.destroy();
  }

  /**
   * Writes the live text now, after taking in whatever changed on disk.
   *
   * Serialised: two flushes never overlap, so `lastPersisted` always names
   * what the file held when the next one starts.
   */
  flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#chain = this.#chain.then(() => this.#persistNow()).catch((error) => this.#deps.log?.(error));
    return this.#chain;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    for (const agent of this.#agents.values()) clearTimeout(agent.timer);
    this.#agents.clear();
    this.awareness.destroy();
    this.doc.destroy();
    this.peers.clear();
    this.#deps.onClosed(this);
  }

  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#deps.persistDelayMs ?? 1000);
    this.#timer.unref?.();
  }

  async #persistNow(): Promise<void> {
    if (this.closed) return;

    const disk = await this.#deps.readDisk(this.owner, this.path);
    if (disk === null) {
      this.closeDeleted(this.owner);
      return;
    }
    if (disk.hash !== this.lastPersisted.hash) {
      // Somebody wrote the file outside the room (vim, rsync, git). Their
      // change is merged in as the owner's, and the file is the new base.
      await this.merge(this.lastPersisted.text, disk.text, { actor: this.owner });
      this.lastPersisted = disk;
    }

    const text = this.text.toString();
    const actors = [...this.#actors];
    this.#actors.clear();
    if (text === this.lastPersisted.text) return;

    try {
      this.lastPersisted = await this.#deps.persist(this.owner, this.path, text, this.lastPersisted.hash, actors);
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        this.closeDeleted(this.owner);
        return;
      }
      for (const actor of actors) this.#actors.add(actor);
      this.#schedule();
      throw error;
    }
    this.control({ type: 'persisted', hash: this.lastPersisted.hash });
  }

  #showAgent(keyName: string, index: number): void {
    const existing = this.#agents.get(keyName);
    if (existing !== undefined) clearTimeout(existing.timer);
    const presence: AgentPresence = existing ?? {
      clientID: Math.floor(Math.random() * 0x7fffffff),
      clock: 0,
      timer: setTimeout(() => undefined, 0),
    };
    const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, index));
    presence.clock += 1;
    applyAwarenessUpdate(
      this.awareness,
      encodeAwarenessState(presence.clientID, presence.clock, {
        user: agentLook(keyName),
        cursor: { anchor: position, head: position },
      }),
      SERVER,
    );
    presence.timer = setTimeout(() => {
      presence.clock += 1;
      if (!this.closed) {
        applyAwarenessUpdate(this.awareness, encodeAwarenessState(presence.clientID, presence.clock, null), SERVER);
      }
      this.#agents.delete(keyName);
    }, this.#deps.agentPresenceMs ?? 5000);
    presence.timer.unref?.();
    this.#agents.set(keyName, presence);
  }
}

function actorOf(origin: unknown): string | null {
  if (typeof origin !== 'object' || origin === null) return null;
  if ('actor' in origin && typeof origin.actor === 'string') return origin.actor;
  if ('userId' in origin && typeof origin.userId === 'string') return origin.userId;
  return null;
}
```

- [ ] **Step 4: Implement `rooms.ts`**

```ts
// server/src/collab/rooms.ts
/**
 * Every open room, by note.
 *
 * Opening is deduplicated: two editors arriving at once must end up in one
 * room, or they would each load the file and edit two diverging copies.
 */

import { Room, type Persisted, type RoomDeps } from './room.js';

export interface RegistryDeps extends Omit<RoomDeps, 'onClosed'> {
  load(owner: string, path: string): Promise<Persisted>;
  maxRooms?: number;
}

export class RoomLimitError extends Error {}

const key = (owner: string, path: string): string => `${owner}\u0000${path}`;

export class RoomRegistry {
  readonly #rooms = new Map<string, Room>();
  readonly #opening = new Map<string, Promise<Room>>();
  readonly #deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get(owner: string, path: string): Room | undefined {
    const room = this.#rooms.get(key(owner, path));
    return room === undefined || room.closed ? undefined : room;
  }

  all(): Room[] {
    return [...this.#rooms.values()];
  }

  open(owner: string, path: string): Promise<Room> {
    const existing = this.get(owner, path);
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = this.#opening.get(key(owner, path));
    if (pending !== undefined) return pending;

    if (this.#rooms.size + this.#opening.size >= (this.#deps.maxRooms ?? 200)) {
      return Promise.reject(new RoomLimitError('too many open notes'));
    }

    const opening = (async () => {
      const initial = await this.#deps.load(owner, path);
      const room = new Room(owner, path, initial, {
        ...this.#deps,
        onClosed: (closed) => {
          if (this.#rooms.get(key(closed.owner, closed.path)) === closed) {
            this.#rooms.delete(key(closed.owner, closed.path));
          }
        },
      });
      this.#rooms.set(key(owner, path), room);
      return room;
    })().finally(() => this.#opening.delete(key(owner, path)));

    this.#opening.set(key(owner, path), opening);
    return opening;
  }

  rekey(owner: string, from: string, to: string): void {
    const room = this.get(owner, from);
    if (room === undefined) return;
    this.#rooms.delete(key(owner, from));
    room.rekey(to);
    this.#rooms.set(key(owner, to), room);
  }

  /** For shutdown: every room writes what it holds. */
  async closeAll(): Promise<void> {
    for (const room of this.all()) {
      await room.flush();
      room.destroy();
    }
  }
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `cd server && npx vitest run test/collab-room.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add server/src/collab/room.ts server/src/collab/rooms.ts server/test/collab-room.test.ts
git commit -m "feat(collab): rooms that transform, merge and persist through the write path"
```

---

### Task 5: Route every content write through an open room

**Files:**
- Modify: `server/src/app.ts` (writes, rename, delete, persist entry, `noteChanged`, `noteVanished`)
- Modify: `server/src/notes/service.ts` (`writeConflictCopy`)
- Modify: `server/src/markdown/edit.ts` (`replaceOnce`)
- Modify: `server/src/mcp/tools.ts` (`edit_note`, `append_note`)
- Modify: `server/src/runtime.ts` (build registry, attach to `App`)
- Test: `server/test/collab-app.test.ts`, `server/test/collab-structure.test.ts`

**Interfaces:**
- Consumes: `RoomRegistry`, `Room`, `Persisted`, `By` (Task 4); `History` (`versions(owner, path): Promise<Version[]>`, `contentAt(owner, path, id): Promise<string>`).
- Produces:
  - `App.attachCollab(rooms: RoomRegistry, history: History | null): void`
  - `App.rooms: RoomRegistry | null` (read-only getter)
  - `App.loadForRoom(owner: string, path: string): Promise<Persisted>`
  - `App.persistFromRoom(owner: string, path: string, text: string, baseHash: string, actors: string[]): Promise<Persisted>`
  - `App.readDiskForRoom(owner: string, path: string): Promise<Persisted | null>`
  - `App.conflictCopyFromRoom(owner: string, path: string, text: string, actor: string): Promise<string>`
  - `App.editNote(owner: string, path: string, find: string, replace: string, actor: string, options?: Authorized & { agent?: boolean }): Promise<PutResult>`
  - `NoteService.writeConflictCopy(owner: string, notePath: string, content: string): Promise<string>`
  - `replaceOnce(source: string, find: string, replace: string): { ok: true; content: string } | { ok: false; occurrences: number }` in `markdown/edit.ts`
  - `Runtime.rooms: RoomRegistry | null`
  - Option `agent?: boolean` accepted by `App.appendNote`, `App.updateNote`, `App.putNote`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/collab-app.test.ts
/**
 * Every way a note's content changes, while a room is open for it.
 *
 * No socket here: a room is opened directly, the way the socket will, and the
 * assertions are about the live text and the file.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-collab-app-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, reconcileIntervalMs: 0, collab: true });
  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.app.createNote('julian', 'N.md', '# N\n\n- [ ] task\n\ntext\n');
});

afterEach(async () => {
  await runtime.rooms?.closeAll();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function openRoom() {
  const room = await runtime.rooms!.open('julian', 'N.md');
  room.join({ userId: 'julian', canWrite: true, clientIds: new Set(), send: () => undefined, close: () => undefined });
  return room;
}

describe('writes into an open room', () => {
  it('appends into the live text, not the file', async () => {
    const room = await openRoom();
    room.transform((live) => live.replace('text', 'live text'), { actor: 'julian' });
    await runtime.app.appendNote('julian', 'N.md', 'from agent', 'claude-code', { agent: true });
    expect(room.text.toString()).toContain('live text');
    expect(room.text.toString()).toContain('from agent');
  });

  it('toggles a task in the live text', async () => {
    const room = await openRoom();
    await runtime.app.toggleTask('julian', 'N.md', 3, { text: 'task', done: false }, true, 'julian');
    expect(room.text.toString()).toContain('- [x] task');
  });

  it('tags in the live text without losing typing since the last persist', async () => {
    const room = await openRoom();
    room.transform((live) => `${live}typed\n`, { actor: 'julian' });
    await runtime.app.bulkTag('julian', ['N.md'], 'topic/x', 'julian');
    expect(room.text.toString()).toContain('typed');
    expect(room.text.toString()).toContain('topic/x');
  });

  it('edits for an agent against the live text', async () => {
    const room = await openRoom();
    room.transform((live) => live.replace('text', 'fresh words'), { actor: 'julian' });
    await runtime.app.editNote('julian', 'N.md', 'fresh words', 'agent words', 'claude-code', { agent: true });
    expect(room.text.toString()).toContain('agent words');
  });

  it('merges a stale whole-text write that names its base', async () => {
    const before = await runtime.app.notes.getNote('julian', 'N.md');
    const room = await openRoom();
    room.transform((live) => live.replace('# N', '# N live'), { actor: 'julian' });
    const result = await runtime.app.putNote('julian', 'N.md', before.content.replace('text', 'old tab'), 'ramona', {
      baseHash: before.hash,
    });
    expect(result.conflictCopy).toBeUndefined();
    expect(room.text.toString()).toContain('# N live');
    expect(room.text.toString()).toContain('old tab');
  });

  it('keeps a write with an unknown base as a conflict copy', async () => {
    const room = await openRoom();
    const result = await runtime.app.putNote('julian', 'N.md', 'something else', 'ramona', { baseHash: 'nope' });
    expect(result.conflictCopy).toMatch(/Konflikt/);
    expect(room.text.toString()).not.toContain('something else');
  });

  it('persists the live text through the write path, logging each actor', async () => {
    const room = await openRoom();
    room.transform((live) => `${live}julian\n`, { actor: 'julian' });
    room.transform((live) => `${live}ramona\n`, { actor: 'ramona' });
    await room.flush();
    const file = await runtime.app.notes.getNote('julian', 'N.md');
    expect(file.content).toBe(room.text.toString());
    const actors = runtime.db
      .all("SELECT actor FROM edits WHERE path = 'N.md' AND action = 'update'")
      .map((row) => String(row['actor']));
    expect(actors).toEqual(expect.arrayContaining(['julian', 'ramona']));
  });

  it('takes in an edit made on disk', async () => {
    const room = await openRoom();
    room.transform((live) => live.replace('# N', '# N live'), { actor: 'julian' });
    const file = path.join(dataDir, 'vaults', 'julian', 'N.md');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('text', 'vim'));
    await runtime.app.noteChanged('julian', 'N.md');
    expect(room.text.toString()).toContain('# N live');
    expect(room.text.toString()).toContain('vim');
  });

  it('behaves exactly as before when no room is open', async () => {
    const before = await runtime.app.notes.getNote('julian', 'N.md');
    await runtime.app.putNote('julian', 'N.md', 'first', 'julian');
    const result = await runtime.app.putNote('julian', 'N.md', 'second', 'ramona', { baseHash: before.hash });
    expect(result.conflictCopy).toMatch(/Konflikt/);
  });
});
```

```ts
// server/test/collab-structure.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;
const noPeer = () => ({
  userId: 'julian',
  canWrite: true,
  clientIds: new Set<number>(),
  sent: [] as Uint8Array[],
  closedWith: undefined as number | undefined,
  send() {},
  close(code: number) {
    this.closedWith = code;
  },
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-collab-structure-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, reconcileIntervalMs: 0, collab: true });
  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.app.createNote('julian', 'A.md', 'links to [[B]]\n');
  await runtime.app.createNote('julian', 'B.md', 'b\n');
});

afterEach(async () => {
  await runtime.rooms?.closeAll();
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('structure changes while a room is open', () => {
  it('rename while open keeps writing to the new path', async () => {
    const room = await runtime.rooms!.open('julian', 'B.md');
    room.join(noPeer());
    room.transform((live) => `${live}typed before\n`, { actor: 'julian' });
    await runtime.app.renameNote('julian', 'B.md', 'Ordner/C.md', { view: 'julian' });
    room.transform((live) => `${live}typed after\n`, { actor: 'julian' });
    await room.flush();

    expect(room.path).toBe('Ordner/C.md');
    const moved = await runtime.app.notes.getNote('julian', 'Ordner/C.md');
    expect(moved.content).toBe('b\ntyped before\ntyped after\n');
    await expect(runtime.app.notes.getNote('julian', 'B.md')).rejects.toThrow();
  });

  it('rewrites a link inside an open referrer through its room', async () => {
    const room = await runtime.rooms!.open('julian', 'A.md');
    room.join(noPeer());
    room.transform((live) => `${live}typing\n`, { actor: 'julian' });
    await runtime.app.renameNote('julian', 'B.md', 'C.md', { view: 'julian' });
    expect(room.text.toString()).toBe('links to [[C]]\ntyping\n');
  });

  it('delete while open persists the last text, then closes the room', async () => {
    const room = await runtime.rooms!.open('julian', 'B.md');
    const peer = noPeer();
    room.join(peer);
    room.transform(() => 'last words\n', { actor: 'julian' });
    await runtime.app.deleteNote('julian', 'B.md', 'julian');
    expect(room.closed).toBe(true);
    expect(peer.closedWith).toBe(4410);
    expect(runtime.rooms!.get('julian', 'B.md')).toBeUndefined();
  });

  it('a file removed on disk closes the room', async () => {
    const room = await runtime.rooms!.open('julian', 'B.md');
    room.join(noPeer());
    await fs.rm(path.join(dataDir, 'vaults', 'julian', 'B.md'));
    runtime.app.noteVanished('julian', 'B.md');
    expect(room.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd server && npx vitest run test/collab-app.test.ts test/collab-structure.test.ts`
Expected: FAIL (`runtime.rooms` undefined, `editNote` missing).

- [ ] **Step 3: `replaceOnce` in `markdown/edit.ts`**

Append:

```ts
/**
 * Replaces `find` when it occurs exactly once; otherwise says how often it did.
 *
 * Spliced by offset rather than with `String.replace`, which reads `$&` and
 * friends in the replacement as patterns even for a plain-string search.
 */
export function replaceOnce(
  source: string,
  find: string,
  replace: string,
): { ok: true; content: string } | { ok: false; occurrences: number } {
  const occurrences = find === '' ? 0 : source.split(find).length - 1;
  if (occurrences !== 1) return { ok: false, occurrences };
  const at = source.indexOf(find);
  return { ok: true, content: source.slice(0, at) + replace + source.slice(at + find.length) };
}
```

- [ ] **Step 4: `writeConflictCopy` in `NoteService`**

Add a public method next to `#preserveDisplaced`, and make `#preserveDisplaced` use the same two lines it already has (`#freeConflictPath`, `writeNote`, `lifecycle.created`) through it:

```ts
  /**
   * Writes `content` beside the note as a conflict copy and answers its path.
   *
   * For a live room whose merge could not place a stale writer's text: the text
   * is kept the same way a displaced version always has been.
   */
  async writeConflictCopy(owner: string, notePath: string, content: string): Promise<string> {
    const canonical = this.#assertNotePath(notePath);
    return this.#locks.run(lockKey(owner, canonical), async () => {
      const copyPath = await this.#freeConflictPath(owner, canonical, new Date());
      await this.#vault.writeNote(owner, copyPath, content);
      this.#lifecycle.created(owner, copyPath);
      return copyPath;
    });
  }
```

Do not call it from inside `#preserveDisplaced` (that already holds the lock); instead extract the three shared lines into a private `#writeCopy(owner, canonical, content)` used by both.

- [ ] **Step 5: `App` routing**

In `server/src/app.ts`:

1. Imports:

```ts
import type { By, Persisted, Room } from './collab/room.js';
import type { RoomRegistry } from './collab/rooms.js';
import type { History } from './vault/history.js';
import { contentHash } from './auth/noteBindings.js';
import { appended, replaceOnce } from './markdown/edit.js';
```

(`appended` may already be imported indirectly; import it where missing.)

2. Fields and attach, after the constructor:

```ts
  #rooms: RoomRegistry | null = null;
  #history: History | null = null;

  /**
   * Live rooms, when collaboration is on.
   *
   * Attached after construction because the registry's own dependencies are
   * methods of this object — the room persists through `persistFromRoom`.
   */
  attachCollab(rooms: RoomRegistry, history: History | null): void {
    this.#rooms = rooms;
    this.#history = history;
  }

  get rooms(): RoomRegistry | null {
    return this.#rooms;
  }

  #room(owner: string, notePath: string): Room | undefined {
    if (this.#rooms === null) return undefined;
    try {
      return this.#rooms.get(owner, normalizeVaultPath(notePath));
    } catch {
      return undefined;
    }
  }

  /** The checks a write makes, for a change that goes into a room instead of the file. */
  async #authorizeLive(owner: string, notePath: string, authorize?: () => void): Promise<void> {
    await this.notes.withLock(owner, notePath, async () => {
      await this.bindings.confirm(owner, notePath);
      authorize?.();
    });
  }

  /**
   * A read-modify-write, against the live text when a room is open and against
   * the file otherwise. The one shape every "change this note" operation takes.
   */
  async #change(
    owner: string,
    notePath: string,
    fn: (content: string) => string,
    actor: string | undefined,
    options: Authorized & { agent?: boolean } = {},
  ): Promise<PutResult> {
    const room = this.#room(owner, notePath);
    if (room !== undefined) {
      await this.#authorizeLive(owner, room.path, options.authorize);
      room.transform(fn, { actor: actor ?? owner, agent: options.agent === true });
      return { note: room.note(), created: false };
    }
    const note = await this.readAuthorized(owner, notePath, options.authorize);
    const content = fn(note.content);
    if (content === note.content) return { note, created: false };
    const write: PutOptions = { baseHash: note.hash };
    if (options.authorize !== undefined) write.authorize = options.authorize;
    return this.updateNote(owner, notePath, content, actor, write);
  }

  /** A whole text for a note whose room is open: overwrite, merge or keep aside. */
  async #intoRoom(
    room: Room,
    owner: string,
    content: string,
    actor: string | undefined,
    options: PutOptions & { agent?: boolean },
  ): Promise<PutResult> {
    await this.#authorizeLive(owner, room.path, options.authorize);
    const by: By = { actor: actor ?? owner, agent: options.agent === true };

    // No base at all is today's plain overwrite (a restore, an owner's own
    // write): the new text replaces the live one, as a change everybody sees.
    if (options.baseHash === undefined && options.baseMtimeMs === undefined) {
      room.transform(() => content, by);
      return { note: room.note(), created: false };
    }

    const base = options.baseHash === undefined ? null : await this.#baseText(owner, room, options.baseHash);
    const { conflictCopy } = base === null ? await room.keepAsConflict(content, by) : await room.merge(base, content, by);
    const result: PutResult = { note: room.note(), created: false };
    if (conflictCopy !== undefined) result.conflictCopy = conflictCopy;
    return result;
  }

  /** The text a writer started from, by its hash: the room's, the file's, or history's. */
  async #baseText(owner: string, room: Room, baseHash: string): Promise<string | null> {
    if (baseHash === room.lastPersisted.hash) return room.lastPersisted.text;
    const live = room.text.toString();
    if (baseHash === contentHash(live)) return live;
    if (this.#history === null) return null;
    try {
      for (const version of (await this.#history.versions(owner, room.path)).slice(0, 20)) {
        const text = await this.#history.contentAt(owner, room.path, version.id);
        if (contentHash(text) === baseHash) return text;
      }
    } catch {
      // No history is "base unknown", which keeps the text aside rather than losing it.
    }
    return null;
  }
```

3. Room entry points (used by the registry in `runtime.ts`):

```ts
  async loadForRoom(owner: string, notePath: string): Promise<Persisted> {
    const note = await this.notes.getNote(owner, notePath);
    return { text: note.content, hash: note.hash };
  }

  async readDiskForRoom(owner: string, notePath: string): Promise<Persisted | null> {
    try {
      return await this.loadForRoom(owner, notePath);
    } catch (error) {
      if (error instanceof NoteNotFoundError) return null;
      throw error;
    }
  }

  /** A room writing its text: the write path, the index, one log row per actor. */
  async persistFromRoom(
    owner: string,
    notePath: string,
    text: string,
    baseHash: string,
    actors: string[],
  ): Promise<Persisted> {
    const result = await this.notes.updateNote(owner, notePath, text, { baseHash });
    await this.indexer.indexNote(owner, result.note.path);
    for (const actor of actors.length === 0 ? [owner] : actors) {
      this.#recordEdit(owner, result.note.path, 'update', actor);
    }
    await this.#recordConflictCopy(owner, result, actors[0]);
    return { text: result.note.content, hash: result.note.hash };
  }

  async conflictCopyFromRoom(owner: string, notePath: string, text: string, actor: string): Promise<string> {
    const copy = await this.notes.writeConflictCopy(owner, notePath, text);
    await this.indexer.indexNote(owner, copy);
    this.#recordEdit(owner, copy, 'create', actor);
    return copy;
  }
```

Check that `NoteNotFoundError` is imported in `app.ts`; add it from `./errors.js` if not.

4. Route the existing writers. At the top of `updateNote` and `putNote`:

```ts
    const room = this.#room(owner, notePath);
    if (room !== undefined) return this.#intoRoom(room, owner, content, actor, options);
```

Change their `options` type to `PutOptions & { agent?: boolean } = {}` and strip `agent` before passing options to `NoteService` (`const { agent: _agent, ...write } = options;`).

At the top of `appendNote`:

```ts
    const room = this.#room(owner, notePath);
    if (room !== undefined) {
      return this.#change(owner, notePath, (live) => appended(live, addition, options.section), actor, options);
    }
```

with `options: AppendOptions & { agent?: boolean } = {}`, stripping `agent` before `this.notes.appendNote`.

Replace the bodies of `toggleTask`, `bulkTag`, `bulkUntag`, `applyTopics` with `#change`:

```ts
  // toggleTask
    return this.#change(
      owner,
      notePath,
      (content) => {
        const result = applyTaskToggle(content, line, expected, done);
        if (!result.ok) {
          throw new TaskChangedError(
            'that task has changed since the list was loaded — reload the task list and try again',
          );
        }
        return result.content;
      },
      actor,
      options,
    );

  // bulkTag, inside #overSelection
      const gate = authorize === undefined ? undefined : (): void => authorize(notePath);
      await this.#change(owner, notePath, (content) => addTag(content, tag), actor, gate === undefined ? {} : { authorize: gate });
      return notePath;

  // bulkUntag: same with removeTag

  // applyTopics, inside the loop, replacing the read/putNote pair
      let changed = false;
      await this.#change(owner, proposal.path, (content) => {
        let next = content;
        for (const tag of proposal.proposed) next = addTag(next, tag);
        changed = next !== content;
        return next;
      }, actor);
      if (changed) done.push({ path: proposal.path, added: proposal.proposed });
```

Keep the docstrings of these methods; update the sentence in `toggleTask` that says it "goes through `updateNote`" to say it goes through `#change`, which is `updateNote` with a base when no room is open.

Add `editNote`:

```ts
  /**
   * Replaces one exact piece of text — MCP `edit_note`.
   *
   * Counted against the live text when a room is open, so an agent edits what
   * people are looking at, not what the file held a second ago.
   */
  async editNote(
    owner: string,
    notePath: string,
    find: string,
    replace: string,
    actor: string,
    options: Authorized & { agent?: boolean } = {},
  ): Promise<PutResult> {
    return this.#change(
      owner,
      notePath,
      (content) => {
        const result = replaceOnce(content, find, replace);
        if (result.ok) return result.content;
        throw new EditNotUniqueError(result.occurrences);
      },
      actor,
      options,
    );
  }
```

and in `app.ts` (top level):

```ts
export class EditNotUniqueError extends Error {
  constructor(readonly occurrences: number) {
    super(occurrences === 0 ? 'that text does not appear in the note' : `that text appears ${occurrences} times`);
  }
}
```

5. Rename and delete. In `renameNote`, before `await this.notes.renameNote(...)`:

```ts
    // Whatever the room holds goes to the file first, so the move carries it.
    await this.#room(owner, source)?.flush();
```

right after the move succeeds, before the referrer loop:

```ts
    this.#rooms?.rekey(owner, source, target);
```

In `#rewriteLinksIn`, extract the replacement computation into a module-level function `rewriteLinks(content: string, oldTarget: string, newTarget: string): string | null` (return `null` when there are no replacements; the body is the existing `parseNote`/`replacements`/splice code), then:

```ts
  async #rewriteLinksIn(owner: string, notePath: string, oldTarget: string, newTarget: string): Promise<boolean> {
    const room = this.#room(owner, notePath);
    if (room !== undefined) {
      let changed = false;
      room.transform((live) => {
        const next = rewriteLinks(live, oldTarget, newTarget);
        changed = next !== null;
        return next ?? live;
      }, { actor: owner });
      return changed;
    }
    const note = await this.notes.getNote(owner, notePath);
    const content = rewriteLinks(note.content, oldTarget, newTarget);
    if (content === null) return false;
    await this.notes.updateNote(owner, notePath, content);
    return true;
  }
```

In `deleteNote`:

```ts
  async deleteNote(owner: string, notePath: string, actor?: string, options: Authorized = {}): Promise<void> {
    const room = this.#room(owner, notePath);
    // The last text goes to the file first, so Recently deleted holds it.
    await room?.flush();
    await this.notes.deleteNote(owner, notePath, options);
    room?.closeDeleted(actor ?? owner);
    // ...existing index/log lines unchanged
  }
```

6. Disk events. In `noteChanged`, before the existing early return:

```ts
    const room = this.#room(owner, notePath);
    if (room !== undefined) await room.flush();
```

(`flush` reads the disk, merges a foreign change, and persists; the room's own writes find the same hash and do nothing.)

In `noteVanished`:

```ts
    this.#room(owner, notePath)?.closeDeleted(owner);
```

- [ ] **Step 6: MCP tools**

In `server/src/mcp/tools.ts`, `edit_note` handler, replace everything from `const note = await context.app.notes.getNote(...)` to the `updateNote` call with:

```ts
      let result;
      try {
        result = await context.app.editNote(
          context.key.owner,
          notePath,
          find,
          input['replace'] as string,
          context.key.name,
          { agent: true },
        );
      } catch (error) {
        if (error instanceof EditNotUniqueError) {
          throw new ToolRefusal(
            error.occurrences === 0
              ? 'that text does not appear in the note'
              : `that text appears ${error.occurrences} times; include more context to make it unique`,
          );
        }
        throw error;
      }
```

Keep the `keys.log` line and the return message. Import `EditNotUniqueError` from `../app.js`. Keep the comment about `$&` in `replaceOnce`'s docstring (already there).

In `append_note` (line ~673), add `agent: true` to the options object passed to `context.app.appendNote`.

Run `npx vitest run test/mcp.test.ts test/concurrency.test.ts test/edit.test.ts` — they must still pass: with no room open, `editNote` reads under the lock and writes with `baseHash`, which is what the tool did before.

- [ ] **Step 7: Runtime wiring**

In `server/src/runtime.ts`: add `rooms: RoomRegistry | null` to `Runtime`; after `const history = ...`:

```ts
  const rooms = config.collab
    ? new RoomRegistry({
        load: (owner, notePath) => app.loadForRoom(owner, notePath),
        readDisk: (owner, notePath) => app.readDiskForRoom(owner, notePath),
        persist: (owner, notePath, text, baseHash, actors) =>
          app.persistFromRoom(owner, notePath, text, baseHash, actors),
        conflictCopy: (owner, notePath, text, actor) => app.conflictCopyFromRoom(owner, notePath, text, actor),
        log: (error) => console.error('collab room:', error),
      })
    : null;
  if (rooms !== null) app.attachCollab(rooms, history);
```

and return `rooms`. In `server/src/main.ts`, in the shutdown path before the database closes: `await runtime.rooms?.closeAll();`.

Tests that build a runtime with `loadConfig()` now get `collab: true` and a registry that stays empty unless a test opens a room, so existing behaviour is unchanged.

- [ ] **Step 8: Run all server tests, typecheck, smoke**

Run: `cd server && npm test && npm run typecheck && npm run smoke`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src server/test/collab-app.test.ts server/test/collab-structure.test.ts
git commit -m "feat(collab): route every content write through an open room"
```

---

### Task 6: Access-change signals

**Files:**
- Modify: `server/src/auth/shares.ts`, `server/src/auth/users.ts`
- Test: `server/test/collab-signals.test.ts`

**Interfaces:**
- Produces: `ShareService.onChange(listener: () => void): () => void`, `SessionService.onChange(listener: () => void): () => void`, `UserService.onChange(listener: () => void): () => void` — each returns an unsubscribe function; listeners run synchronously after the mutation, and a throwing listener never fails the mutation.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/collab-signals.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

let dataDir: string;
let runtime: Runtime;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-signals-'));
  runtime = await createRuntime({ ...loadConfig(), dataDir, reconcileIntervalMs: 0 });
  await runtime.users.create('julian', 'ein gutes passwort');
  await runtime.users.create('ramona', 'ihr gutes passwort');
  await runtime.app.createNote('julian', 'Ordner/N.md', 'x');
});

afterEach(async () => {
  runtime.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('access changes are announced', () => {
  it('for every share mutation', async () => {
    const heard = vi.fn();
    runtime.shares.onChange(heard);
    const share = runtime.shares.grant('julian', 'Ordner', 'ramona', false);
    runtime.shares.grant('julian', 'Ordner', 'ramona', true);
    runtime.shares.moveFolder('julian', 'Ordner', 'Neu');
    runtime.shares.revoke(share.id);
    await runtime.app.grantShare('julian', 'ramona', { kind: 'note', path: 'Ordner/N.md' }, false);
    runtime.shares.dropNote('julian', 'Ordner/N.md');
    runtime.shares.dropFolder('julian', 'Neu');
    expect(heard.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  it('for sessions and accounts', () => {
    const sessions = vi.fn();
    const users = vi.fn();
    runtime.sessions.onChange(sessions);
    runtime.users.onChange(users);
    const { token } = runtime.sessions.create('ramona');
    runtime.sessions.destroy(token);
    runtime.sessions.destroyAllFor('ramona');
    runtime.users.setDisabled('ramona', true);
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(users).toHaveBeenCalledTimes(1);
  });

  it('never fails the mutation', () => {
    runtime.shares.onChange(() => {
      throw new Error('listener broke');
    });
    expect(() => runtime.shares.grant('julian', 'Ordner', 'ramona', false)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run test/collab-signals.test.ts`
Expected: FAIL, `onChange` is not a function.

- [ ] **Step 3: Implement**

Add to each of `ShareService`, `SessionService`, `UserService`:

```ts
  readonly #listeners = new Set<() => void>();

  /** Told after anything that can change who may reach what; see `collab/socket.ts`. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A listener is an observer; the mutation already happened and stands.
      }
    }
  }
```

Call `this.#changed()` at the end of: `ShareService.grant`, `revoke`, `moveNote`, `dropNoteBoundTo`, `dropNote`, `moveFolder`, `dropFolder`; `SessionService.destroy`, `destroyAllFor`; `UserService.setDisabled`, `setPassword`. (`bindNote`/`rebindNote` change no access and stay silent.)

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
cd server && npx vitest run test/collab-signals.test.ts && npm test && npm run typecheck
git add server/src/auth server/test/collab-signals.test.ts
git commit -m "feat(auth): announce access changes"
```

---

### Task 7: The WebSocket endpoint

**Files:**
- Create: `server/src/collab/socket.ts`
- Modify: `server/src/http/server.ts` (register when `config.collab && deps.rooms`), `ServerDeps` gets `rooms?: RoomRegistry | null`
- Modify: `server/src/main.ts` and `server/test/support/harness.ts` (pass `rooms: runtime.rooms`)
- Test: `server/test/collab-socket.test.ts`

**Interfaces:**
- Consumes: `RoomRegistry`, `Room`, `Peer`, `encodeControl`, `encodeAwareness` (Task 4); `personLook`, `sanitizeAwareness` (Task 3); `onChange` signals (Task 6); `CLOSE`, `MESSAGE_*`, `COLLAB_PATH` (Task 1).
- Produces: `registerCollab(fastify: FastifyInstance, deps: CollabDeps): Promise<void>` with `interface CollabDeps { app: App; rooms: RoomRegistry; shares: ShareService; sessions: SessionService; users: UserService; config: Config; recheckMs?: number }`.

- [ ] **Step 1: Write the failing tests**

`@fastify/websocket` adds `fastify.injectWS(path, { headers })` for tests; it resolves to a `ws` WebSocket connected to the route without a real port.

```ts
// server/test/collab-socket.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type WebSocket from 'ws';

import { COLLAB_PATH, Control, MESSAGE_CONTROL, MESSAGE_SYNC } from '../../shared/collab.js';
import { startHarness, type Harness } from './support/harness.js';

let h: Harness;

beforeEach(async () => {
  h = await startHarness('collab-socket', { collab: true });
  await h.runtime.users.create('julian', 'ein gutes passwort');
  await h.runtime.users.create('ramona', 'ihr gutes passwort');
  await h.login('julian', 'ein gutes passwort');
  await h.login('ramona', 'ihr gutes passwort');
  await h.runtime.app.createNote('julian', 'N.md', 'hello\n');
});

afterEach(async () => {
  await h.close();
});

interface Client {
  ws: WebSocket;
  doc: Y.Doc;
  controls: Control[];
  closed: Promise<number>;
}

async function connect(user: string, url: string, origin = 'http://localhost:80'): Promise<Client> {
  const ws = await h.server.injectWS(url, { headers: { cookie: h.cookieOf(user), origin, host: 'localhost:80' } });
  const doc = new Y.Doc();
  const controls: Control[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_CONTROL) {
      const control = Control.parse(JSON.parse(decoding.readVarString(decoder)));
      controls.push(control);
      if (control.type === 'hello') {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, doc);
        ws.send(encoding.toUint8Array(encoder));
      }
    } else if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, 'server');
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
    }
  });
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'server') return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  return { ws, doc, controls, closed };
}

const until = async (check: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const url = (owner: string, path: string) =>
  `${COLLAB_PATH}?owner=${encodeURIComponent(owner)}&path=${encodeURIComponent(path)}`;

describe('the collab socket', () => {
  it('syncs the note and says hello first', async () => {
    const c = await connect('julian', url('julian', 'N.md'));
    await until(() => c.doc.getText('content').toString() === 'hello\n');
    expect(c.controls[0]?.type).toBe('hello');
  });

  it('carries typing from one editor to another and into the file', async () => {
    const a = await connect('julian', url('julian', 'N.md'));
    const b = await connect('julian', url('julian', 'N.md'));
    await until(() => b.doc.getText('content').length > 0);
    a.doc.getText('content').insert(0, 'A: ');
    await until(() => b.doc.getText('content').toString() === 'A: hello\n');
    a.ws.close();
    b.ws.close();
    await until(() => h.runtime.rooms!.size === 0);
    expect((await h.runtime.app.notes.getNote('julian', 'N.md')).content).toBe('A: hello\n');
  });

  it('refuses a foreign origin', async () => {
    await expect(connect('julian', url('julian', 'N.md'), 'https://evil.example')).rejects.toThrow();
  });

  it('answers a missing and a forbidden note identically', async () => {
    const missing = await connect('ramona', url('ramona', 'Nope.md'));
    const forbidden = await connect('ramona', url('julian', 'N.md'));
    expect(await missing.closed).toBe(4404);
    expect(await forbidden.closed).toBe(4404);
  });

  it('drops updates from a read-only share', async () => {
    h.runtime.shares.grant('julian', '', 'ramona', false);
    const reader = await connect('ramona', url('julian', 'N.md'));
    await until(() => reader.controls.some((c) => c.type === 'hello'));
    expect(reader.controls[0]).toMatchObject({ type: 'hello', canWrite: false });
    await until(() => reader.doc.getText('content').length > 0);
    reader.doc.getText('content').insert(0, 'sneaky ');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.runtime.rooms!.get('julian', 'N.md')!.text.toString()).toBe('hello\n');
  });

  it('closes when the share is withdrawn', async () => {
    const share = h.runtime.shares.grant('julian', '', 'ramona', true);
    const c = await connect('ramona', url('julian', 'N.md'));
    await until(() => c.controls.length > 0);
    h.runtime.shares.revoke(share.id);
    expect(await c.closed).toBe(4404);
  });

  it('downgrades to read-only when a share loses write', async () => {
    h.runtime.shares.grant('julian', '', 'ramona', true);
    const c = await connect('ramona', url('julian', 'N.md'));
    await until(() => c.controls.length > 0);
    h.runtime.shares.grant('julian', '', 'ramona', false);
    await until(() => c.controls.some((m) => m.type === 'access' && !m.canWrite));
  });

  it('closes on logout', async () => {
    const c = await connect('julian', url('julian', 'N.md'));
    await until(() => c.controls.length > 0);
    await h.as('julian', { method: 'POST', url: '/api/v1/auth/logout' });
    expect(await c.closed).toBe(4404);
  });

  it('shows an agent append live', async () => {
    const c = await connect('julian', url('julian', 'N.md'));
    await until(() => c.doc.getText('content').length > 0);
    await h.runtime.app.appendNote('julian', 'N.md', 'agent line', 'claude-code', { agent: true });
    await until(() => c.doc.getText('content').toString().includes('agent line'));
  });

  it('limits sockets per account', async () => {
    const clients = [];
    for (let i = 0; i < 20; i++) clients.push(await connect('julian', url('julian', 'N.md')));
    const extra = await connect('julian', url('julian', 'N.md'));
    expect(await extra.closed).toBe(4429);
  });
});
```

Add to `server/test/support/harness.ts`: a `cookieOf(user: string): string` method returning the stored `name=value` cookie for `user` (the harness already keeps it for `as`), and pass `rooms: runtime.rooms` to `buildServer`.

- [ ] **Step 2: Run to see it fail**

Run: `cd server && npx vitest run test/collab-socket.test.ts`
Expected: FAIL, `injectWS` is not a function (plugin not registered).

- [ ] **Step 3: Implement `socket.ts`**

```ts
// server/src/collab/socket.ts
/**
 * `/api/v1/collab`: one WebSocket per open editor.
 *
 * Authentication is the session cookie, checked by the same `onRequest` hook as
 * every other `/api/` route. Because browsers send that cookie on cross-site
 * WebSocket upgrades too, the Origin header is checked before anything else.
 *
 * The permission check is the note's: read to join, write to change. A refusal
 * closes exactly like a missing note. Access is checked again whenever shares,
 * sessions or accounts change, and every `recheckMs` as a backstop.
 */

import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type WebSocket from 'ws';

import { CLOSE, COLLAB_PATH, MESSAGE_AWARENESS, MESSAGE_SYNC } from '../../../shared/collab.js';
import type { App } from '../app.js';
import type { ShareService } from '../auth/shares.js';
import type { SessionService, UserService } from '../auth/users.js';
import type { Config } from '../config.js';
import { isNotePath, normalizeVaultPath } from '../vault/paths.js';
import { personLook, sanitizeAwareness } from './awareness.js';
import { encodeAwareness, type Peer, type Room } from './room.js';
import { RoomLimitError, type RoomRegistry } from './rooms.js';

export interface CollabDeps {
  app: App;
  rooms: RoomRegistry;
  shares: ShareService;
  sessions: SessionService;
  users: UserService;
  config: Config;
  recheckMs?: number;
}

const MAX_PAYLOAD = 8 * 1024 * 1024;
const MAX_SOCKETS_PER_USER = 20;
const RATE_PER_SECOND = 200;
const RATE_BURST = 400;
const MAX_CLIENT_IDS = 4;

interface Connection extends Peer {
  token: string;
  room: Room;
  tokens: number;
  refilledAt: number;
}

function ownOrigin(request: FastifyRequest, config: Config): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  if (config.allowedOrigins.includes(origin)) return true;
  return origin === `${request.protocol}://${request.host}`;
}

export async function registerCollab(fastify: FastifyInstance, deps: CollabDeps): Promise<void> {
  const { app, rooms, shares, sessions, users, config } = deps;
  const connections = new Set<Connection>();

  await fastify.register(websocket, { options: { maxPayload: MAX_PAYLOAD } });

  /** Closes or downgrades every connection whose access changed. */
  const recheck = (): void => {
    for (const conn of connections) {
      const session = sessions.resolve(conn.token);
      const user = session === null ? undefined : users.get(session.userId);
      const canRead =
        user !== undefined && !user.disabled && shares.allows(conn.userId, conn.room.owner, conn.room.path, 'read');
      if (!canRead) {
        conn.close(CLOSE.gone, 'not found');
        continue;
      }
      const canWrite = shares.allows(conn.userId, conn.room.owner, conn.room.path, 'write');
      if (canWrite !== conn.canWrite) {
        conn.canWrite = canWrite;
        conn.room.control({ type: 'access', canWrite }, conn);
      }
    }
  };
  const unsubscribe = [shares.onChange(recheck), sessions.onChange(recheck), users.onChange(recheck)];
  const backstop = setInterval(recheck, deps.recheckMs ?? 60_000);
  backstop.unref();
  fastify.addHook('onClose', async () => {
    clearInterval(backstop);
    for (const off of unsubscribe) off();
  });

  fastify.get(
    COLLAB_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!ownOrigin(request, config)) {
          await reply.code(403).send({ code: 'forbidden_origin', message: 'wrong origin' });
        }
      },
    },
    async (socket: WebSocket, request: FastifyRequest) => {
      const user = request.user!;
      const token = request.cookies['ndbrain_session'] ?? '';
      const query = request.query as { owner?: string; path?: string };
      const owner = typeof query.owner === 'string' && query.owner !== '' ? query.owner : user.id;

      const gone = (): void => socket.close(CLOSE.gone, 'not found');

      if ([...connections].filter((c) => c.userId === user.id).length >= MAX_SOCKETS_PER_USER) {
        socket.close(CLOSE.limit, 'too many connections');
        return;
      }

      let notePath: string;
      try {
        notePath = normalizeVaultPath(String(query.path ?? ''));
        if (!isNotePath(notePath)) throw new Error('not a note');
        if (owner !== user.id && shares.hasNoteShare(user.id, owner, notePath)) {
          await app.noteChanged(owner, notePath);
        }
        shares.check(user.id, owner, notePath, 'read');
      } catch {
        gone();
        return;
      }

      let room: Room;
      try {
        room = await rooms.open(owner, notePath);
      } catch (error) {
        if (error instanceof RoomLimitError) socket.close(CLOSE.full, 'too many open notes');
        else gone();
        return;
      }

      const look = personLook(user.id, user.displayName);
      const conn: Connection = {
        userId: user.id,
        token,
        room,
        canWrite: shares.allows(user.id, owner, notePath, 'write'),
        clientIds: new Set(),
        tokens: RATE_BURST,
        refilledAt: Date.now(),
        send: (message) => {
          if (socket.readyState === socket.OPEN) socket.send(message);
        },
        close: (code, reason) => socket.close(code, reason),
      };
      connections.add(conn);
      room.join(conn);

      // Hello first: the client checks the epoch before it syncs anything.
      room.control(
        { type: 'hello', epoch: room.epoch, canWrite: conn.canWrite, persistedHash: room.lastPersisted.hash },
        conn,
      );
      const step1 = encoding.createEncoder();
      encoding.writeVarUint(step1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(step1, room.doc);
      conn.send(encoding.toUint8Array(step1));
      const states = [...room.awareness.getStates().keys()];
      if (states.length > 0) conn.send(encodeAwareness(encodeAwarenessUpdate(room.awareness, states)));

      const claim = (clientID: number): boolean => {
        if (conn.clientIds.has(clientID)) return true;
        for (const other of room.peers) if (other !== conn && other.clientIds.has(clientID)) return false;
        if (conn.clientIds.size >= MAX_CLIENT_IDS) return false;
        conn.clientIds.add(clientID);
        return true;
      };

      socket.on('message', (data: Buffer) => {
        const now = Date.now();
        conn.tokens = Math.min(RATE_BURST, conn.tokens + ((now - conn.refilledAt) / 1000) * RATE_PER_SECOND);
        conn.refilledAt = now;
        if (conn.tokens < 1) {
          socket.close(CLOSE.limit, 'too many messages');
          return;
        }
        conn.tokens -= 1;

        try {
          const decoder = decoding.createDecoder(new Uint8Array(data));
          const type = decoding.readVarUint(decoder);
          const current = conn.room;
          if (type === MESSAGE_SYNC) {
            // Peek at the sync subtype: a reader may ask for the state (step 1)
            // but never send changes (step 2, update).
            const subtype = decoding.peekVarUint(decoder);
            if (!conn.canWrite && subtype !== syncProtocol.messageYjsSyncStep1) return;
            const reply = encoding.createEncoder();
            encoding.writeVarUint(reply, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(decoder, reply, current.doc, conn);
            if (encoding.length(reply) > 1) conn.send(encoding.toUint8Array(reply));
          } else if (type === MESSAGE_AWARENESS) {
            const clean = sanitizeAwareness(decoding.readVarUint8Array(decoder), claim, look);
            // Applied through y-protocols so the room broadcasts it like any other.
            if (clean !== null) applyAwarenessUpdate(current.awareness, clean, conn);
          }
        } catch {
          socket.close(CLOSE.gone, 'not found');
        }
      });

      socket.on('close', () => {
        connections.delete(conn);
        void conn.room.leave(conn);
      });
    },
  );
}
```

- [ ] **Step 4: Register in `buildServer`**

In `server/src/http/server.ts`: add `rooms?: RoomRegistry | null` to `ServerDeps`; after the `onRequest` hook is added and before the routes:

```ts
  if (config.collab && deps.rooms !== undefined && deps.rooms !== null) {
    await registerCollab(fastify, { app, rooms: deps.rooms, shares, sessions, users, config });
  }
```

Pass `rooms: runtime.rooms` in `main.ts` and in the harness.

- [ ] **Step 5: Run the socket tests, the full suite, typecheck, smoke**

Run: `cd server && npx vitest run test/collab-socket.test.ts && npm test && npm run typecheck && npm run smoke`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src server/test/collab-socket.test.ts server/test/support/harness.ts
git commit -m "feat(collab): the WebSocket endpoint with origin check, permissions and limits"
```

---

### Task 8: Browser provider and hook

**Files:**
- Create: `web/src/collab/provider.ts`, `web/src/collab/useCollab.ts`
- Modify: `web/vite.config.ts` (dev proxy `ws: true`)
- Test: `web/test/collab-provider.test.ts`

**Interfaces:**
- Consumes: `shared/collab.ts` (Task 1); `api.putNote(owner, path, content, baseHash?)` from `web/src/api.ts`.
- Produces:
  - `type CollabStatus = 'connecting' | 'live' | 'offline' | 'unavailable' | 'gone' | 'deleted' | 'rebase'`
  - `class CollabProvider` with `doc: Y.Doc`, `text: Y.Text`, `awareness: Awareness`, `status: CollabStatus`, `canWrite: boolean`, `synced: boolean`, `persistedHash: string | null`, `dirtyOffline: boolean`, `on(event: 'status' | 'control' | 'synced', fn): () => void`, `destroy(): void`; constructor `new CollabProvider({ owner, path, url?, WebSocketImpl?, epoch? })`.
  - `interface Peer { clientId: number; name: string; color: string; self: boolean }`
  - `useCollab(ref: { owner: string; path: string } | null, enabled: boolean, handlers: { onMoved(owner: string, path: string): void; onDeleted(by: string): void; onGone(): void }): { provider: CollabProvider | null; status: CollabStatus; peers: Peer[]; canWrite: boolean; synced: boolean }`

- [ ] **Step 1: Write the failing tests**

The test builds a fake server over a fake `WebSocket` class, speaking the same protocol with y-protocols, so the provider is tested against real messages.

```ts
// web/test/collab-provider.test.ts
import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { CLOSE, MESSAGE_CONTROL, MESSAGE_SYNC } from '../../shared/collab';
import { CollabProvider } from '../src/collab/provider';

/** A server room in the test: one doc, an epoch, any number of fake sockets. */
class FakeServer {
  doc = new Y.Doc();
  sockets = new Set<FakeSocket>();
  constructor(public epoch: string, text: string) {
    this.doc.getText('content').insert(0, text);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeUpdate(e, update);
      for (const s of this.sockets) if (s !== origin) s.deliver(encoding.toUint8Array(e));
    });
  }
  accept(socket: FakeSocket) {
    this.sockets.add(socket);
    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, MESSAGE_CONTROL);
    encoding.writeVarString(hello, JSON.stringify({ type: 'hello', epoch: this.epoch, canWrite: true, persistedHash: 'h0' }));
    socket.deliver(encoding.toUint8Array(hello));
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, this.doc);
    socket.deliver(encoding.toUint8Array(step1));
  }
  receive(socket: FakeSocket, data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, reply, this.doc, socket);
    if (encoding.length(reply) > 1) socket.deliver(encoding.toUint8Array(reply));
  }
}

let server: FakeServer | null = null;
let refuseWith: number | null = null;

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => {
      if (refuseWith !== null || server === null) {
        this.onclose?.({ code: refuseWith ?? 1006 });
        return;
      }
      this.readyState = 1;
      this.onopen?.();
      server.accept(this);
    }, 0);
  }
  deliver(data: Uint8Array) {
    setTimeout(() => this.onmessage?.({ data: data.slice().buffer }), 0);
  }
  send(data: Uint8Array) {
    const s = server;
    setTimeout(() => s?.receive(this, data), 0);
  }
  close(code = 1000) {
    this.readyState = 3;
    server?.sockets.delete(this);
    setTimeout(() => this.onclose?.({ code }), 0);
  }
}

const until = async (check: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const make = () =>
  new CollabProvider({ owner: 'julian', path: 'N.md', url: 'ws://test', WebSocketImpl: FakeSocket as unknown as typeof WebSocket });

describe('CollabProvider', () => {
  it('syncs the room and goes live', async () => {
    server = new FakeServer('e1', 'hello');
    refuseWith = null;
    const p = make();
    await until(() => p.synced);
    expect(p.status).toBe('live');
    expect(p.text.toString()).toBe('hello');
    p.destroy();
  });

  it('sends local typing to the room', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    await until(() => p.synced);
    p.text.insert(0, '> ');
    await until(() => server!.doc.getText('content').toString() === '> hello');
    p.destroy();
  });

  it('new epoch rebases instead of syncing', async () => {
    server = new FakeServer('e1', 'hello');
    const p = make();
    await until(() => p.synced);
    for (const s of [...server.sockets]) s.close(1006);
    await until(() => p.status === 'offline');
    p.text.insert(5, ' offline');
    server = new FakeServer('e2', 'hello');
    await until(() => p.status === 'rebase', 5000);
    expect(server.doc.getText('content').toString()).toBe('hello');
    expect(p.dirtyOffline).toBe(true);
    expect(p.text.toString()).toBe('hello offline');
    p.destroy();
  });

  it('falls back when no socket ever connects', async () => {
    server = null;
    refuseWith = 1006;
    const p = make();
    await until(() => p.status === 'unavailable', 5000);
    p.destroy();
  });

  it('closes with 1009 fall back to unavailable', async () => {
    server = null;
    refuseWith = 1009;
    const p = make();
    await until(() => p.status === 'unavailable', 5000);
    p.destroy();
  });

  it('reports a note that is gone', async () => {
    server = null;
    refuseWith = CLOSE.gone;
    const p = make();
    await until(() => p.status === 'gone');
    p.destroy();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd web && npx vitest run test/collab-provider.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the provider**

```ts
// web/src/collab/provider.ts
/**
 * The browser end of a live note.
 *
 * Nothing is sent until the server's hello has been read: the hello carries the
 * room's epoch, and a doc from an earlier epoch must never be synced into a new
 * room — both sides inserted the whole text as their own operations, so a merge
 * would show it twice. On an epoch change the provider stops and reports
 * `rebase`; the hook sends the text through the ordinary save path and starts a
 * fresh provider.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  CLOSE,
  COLLAB_PATH,
  Control,
  MESSAGE_AWARENESS,
  MESSAGE_CONTROL,
  MESSAGE_SYNC,
} from '../../../shared/collab';

export type CollabStatus = 'connecting' | 'live' | 'offline' | 'unavailable' | 'gone' | 'deleted' | 'rebase';

export interface ProviderOptions {
  owner: string;
  path: string;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

type Events = {
  status: (status: CollabStatus) => void;
  control: (control: Control) => void;
  synced: () => void;
};

const FAILED_ATTEMPTS_BEFORE_FALLBACK = 2;
const MAX_BACKOFF_MS = 10_000;

export class CollabProvider {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: awarenessProtocol.Awareness;
  status: CollabStatus = 'connecting';
  canWrite = false;
  synced = false;
  persistedHash: string | null = null;
  /** Typed while not connected: owed to the server if this room is gone. */
  dirtyOffline = false;

  readonly #options: ProviderOptions;
  readonly #listeners: { [K in keyof Events]: Set<Events[K]> } = {
    status: new Set(),
    control: new Set(),
    synced: new Set(),
  };
  #ws: WebSocket | null = null;
  #epoch: string | null = null;
  #helloSeen = false;
  #everLive = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #destroyed = false;

  constructor(options: ProviderOptions) {
    this.#options = options;
    this.text = this.doc.getText('content');
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      if (this.status !== 'live') this.dirtyOffline = true;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.#send(encoding.toUint8Array(e));
    });

    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const mine = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
      if (mine.length === 0) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, mine));
      this.#send(encoding.toUint8Array(e));
    });

    this.#connect();
  }

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    this.#listeners[event].add(fn);
    return () => this.#listeners[event].delete(fn);
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.#ws?.close(1000);
    this.awareness.destroy();
    this.doc.destroy();
  }

  #setStatus(status: CollabStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const fn of this.#listeners.status) fn(status);
  }

  #url(): string {
    if (this.#options.url !== undefined) return this.#options.url;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = `owner=${encodeURIComponent(this.#options.owner)}&path=${encodeURIComponent(this.#options.path)}`;
    return `${scheme}//${location.host}${COLLAB_PATH}?${query}`;
  }

  #send(message: Uint8Array): void {
    // Nothing leaves before the hello: see the file comment.
    if (this.#helloSeen && this.#ws !== null && this.#ws.readyState === 1) this.#ws.send(message);
  }

  #connect(): void {
    if (this.#destroyed) return;
    const Impl = this.#options.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.#url());
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    this.#helloSeen = false;

    ws.onmessage = (event: MessageEvent) => this.#receive(new Uint8Array(event.data as ArrayBuffer));
    ws.onclose = (event: CloseEvent) => this.#closed(event.code);
  }

  #receive(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);

    if (type === MESSAGE_CONTROL) {
      const control = Control.parse(JSON.parse(decoding.readVarString(decoder)));
      if (control.type === 'hello') {
        if (this.#epoch !== null && control.epoch !== this.#epoch) {
          this.#ws?.close(1000);
          this.#destroyed = true;
          this.#setStatus('rebase');
          return;
        }
        this.#epoch = control.epoch;
        this.#helloSeen = true;
        this.canWrite = control.canWrite;
        this.persistedHash = control.persistedHash;
        this.#failures = 0;
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(e, this.doc);
        this.#send(encoding.toUint8Array(e));
      } else if (control.type === 'persisted') {
        this.persistedHash = control.hash;
      } else if (control.type === 'access') {
        this.canWrite = control.canWrite;
      }
      for (const fn of this.#listeners.control) fn(control);
      return;
    }

    if (!this.#helloSeen) return;

    if (type === MESSAGE_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      const subtype = syncProtocol.readSyncMessage(decoder, e, this.doc, this);
      if (encoding.length(e) > 1) this.#send(encoding.toUint8Array(e));
      if (subtype === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.#everLive = true;
        this.dirtyOffline = false;
        this.#setStatus('live');
        for (const fn of this.#listeners.synced) fn();
      } else if (subtype === syncProtocol.messageYjsSyncStep2) {
        this.dirtyOffline = false;
        this.#setStatus('live');
      }
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  #closed(code: number): void {
    this.#ws = null;
    if (this.#destroyed) return;
    if (code === CLOSE.gone) return this.#setStatus('gone');
    if (code === CLOSE.deleted) return this.#setStatus('deleted');

    if (!this.#everLive) {
      this.#failures += 1;
      if (this.#failures >= FAILED_ATTEMPTS_BEFORE_FALLBACK || code === 1009 || code === CLOSE.limit || code === CLOSE.full) {
        return this.#setStatus('unavailable');
      }
    } else {
      this.#setStatus('offline');
    }

    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.#failures, 5));
    this.#failures += this.#everLive ? 1 : 0;
    this.#retry = setTimeout(() => this.#connect(), delay);
  }
}
```

After a reconnect with the same epoch, `synced` is already `true`; the second branch of the step-2 check puts the status back to `live`.

- [ ] **Step 4: Implement the hook**

```ts
// web/src/collab/useCollab.ts
/**
 * The live connection for the open note.
 *
 * One provider per (owner, path) and per generation: a rebase — the room was
 * recreated while this tab was away — sends the text through the ordinary save
 * path with the last persisted hash as base, then starts a fresh provider.
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
    if (user?.name === undefined) return;
    out.push({ clientId, name: user.name, color: user.color ?? '#888', self: clientId === provider.doc.clientID });
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
    // The server sets the name; this only makes the local cursor visible.
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

    // Leaving the page while offline: what was typed goes out through the
    // ordinary save, with keepalive, against the last persisted version.
    const onLeave = (): void => {
      if (provider.status !== 'live' && provider.dirtyOffline) {
        void api.putNote(owner, path, provider.text.toString(), provider.persistedHash ?? undefined).catch(() => undefined);
      }
    };
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);

    return () => {
      for (const off of offs) off();
      provider.awareness.off('change', onAwareness);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
      onLeave();
      provider.destroy();
    };
  }, [enabled, owner, path, generation]);

  return state;
}
```

- [ ] **Step 5: Dev proxy**

In `web/vite.config.ts`, change the proxy entry to:

```ts
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false, ws: true },
```

- [ ] **Step 6: Run tests, typecheck, commit**

```bash
cd web && npx vitest run test/collab-provider.test.ts && npm run typecheck
git add web/src/collab web/test/collab-provider.test.ts web/vite.config.ts
git commit -m "feat(web): collab provider with epoch check, reconnect and fallback"
```

---

### Task 9: Editor, presence and App wiring

**Files:**
- Modify: `web/src/Editor.tsx`
- Create: `web/src/collab/Presence.tsx`
- Modify: `web/src/App.tsx` (around the `<Editor` at line ~2024, `SaveIndicator` at ~1938, `openNote`'s `opened(...)` at ~571)
- Modify: `web/src/copy.ts`, `web/src/styles.css`
- Test: `web/test/editor-collab.test.ts`, `web/test/presence.test.tsx`

**Interfaces:**
- Consumes: `CollabProvider`, `useCollab`, `Peer` (Task 8).
- Produces: `EditorProps.collab?: { text: Y.Text; awareness: Awareness } | null`; `NoteExtensions.collab?: { text: Y.Text; awareness: Awareness; undo: Y.UndoManager }`; `Presence({ peers, status }: { peers: Peer[]; status: CollabStatus }): JSX.Element`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/test/editor-collab.test.ts
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from 'y-codemirror.next';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { noteExtensions } from '../src/Editor';

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'));
  a.getText('content').insert(0, 'hello');
  return { a, b };
}

function viewOn(doc: Y.Doc): EditorView {
  const text = doc.getText('content');
  const collab = { text, awareness: new Awareness(doc), undo: new Y.UndoManager(text) };
  const state = EditorState.create({
    doc: text.toString(),
    extensions: noteExtensions({ owner: 'julian', path: 'N.md', collab }),
  });
  return new EditorView({ state, parent: document.body });
}

describe('the editor with collab', () => {
  it('shows remote changes', () => {
    const { a, b } = pair();
    const view = viewOn(a);
    b.getText('content').insert(5, ' world');
    expect(view.state.doc.toString()).toBe('hello world');
    view.destroy();
  });

  it('undo only reverts local changes', () => {
    const { a, b } = pair();
    const view = viewOn(a);
    view.dispatch({ changes: { from: 5, insert: ' mine' } });
    b.getText('content').insert(0, 'theirs ');
    undo(view);
    expect(view.state.doc.toString()).toBe('theirs hello');
    view.destroy();
  });

  it('keeps the bytes of a note with CRLF and emoji', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, '# 🧠\r\n- [ ] a\r\n');
    const view = viewOn(doc);
    expect(view.state.doc.toString()).toBe('# 🧠\r\n- [ ] a\r\n');
    view.destroy();
  });
});
```

If CodeMirror normalises `\r\n` in the view (it does by default), the byte promise is kept at the Y.Text, not the view: change the third test to assert `doc.getText('content').toString()` after a local edit at the end, and set `EditorState.lineSeparator.of('\n')` only if the existing non-collab round-trip tests already do so. Check `web/test` for the existing round-trip test and follow exactly what it does; the collab path must not change it.

```tsx
// web/test/presence.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Presence } from '../src/collab/Presence';

describe('Presence', () => {
  it('lists others by initials, once per name', () => {
    render(
      <Presence
        status="live"
        peers={[
          { clientId: 1, name: 'Julian', color: '#0ff', self: true },
          { clientId: 2, name: 'Ramona', color: '#f0f', self: false },
          { clientId: 3, name: 'Ramona', color: '#f0f', self: false },
          { clientId: 4, name: '🤖 claude-code', color: '#ff0', self: false },
        ]}
      />,
    );
    expect(screen.getAllByTitle('Ramona')).toHaveLength(1);
    expect(screen.getByTitle('🤖 claude-code')).toBeInTheDocument();
    expect(screen.queryByTitle('Julian')).toBeNull();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('says when it is offline', () => {
    render(<Presence status="offline" peers={[]} />);
    expect(screen.getByText(/Offline/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd web && npx vitest run test/editor-collab.test.ts test/presence.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Editor**

In `web/src/Editor.tsx`:

```ts
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
```

Add to `NoteExtensions`:

```ts
  /**
   * A live room. The document then comes from the shared text, and undo is
   * Yjs's, scoped to this tab: ⌘Z must never take back what somebody else typed.
   */
  collab?: { text: Y.Text; awareness: Awareness; undo: Y.UndoManager };
```

In `noteExtensions`, destructure `collab`, replace `history(),` with `...(collab === undefined ? [history()] : [yCollab(collab.text, collab.awareness, { undoManager: collab.undo })]),` and replace `...historyKeymap,` with `...(collab === undefined ? historyKeymap : yUndoManagerKeymap),`.

Add to `EditorProps`:

```ts
  /** The live room for this note, once it has synced; null or absent is today's mode. */
  collab?: { text: Y.Text; awareness: Awareness } | null;
```

In `Editor`, build with it:

```ts
    const live =
      collab === null || collab === undefined
        ? undefined
        : { ...collab, undo: new Y.UndoManager(collab.text) };
    const state = EditorState.create({
      doc: live === undefined ? initialContent : live.text.toString(),
      // ...extensions as before, passing `collab: live` into noteExtensions
    });
```

destroy `live?.undo.destroy()` in the cleanup, and add `collab?.text` to the effect's dependency list (`[owner, path, readOnly, collab?.text]`).

- [ ] **Step 4: Presence**

```tsx
// web/src/collab/Presence.tsx
/**
 * Who else is in this note, and whether the live connection holds.
 *
 * One mark per name: a person with two tabs open is one person here, even
 * though both of their cursors show in the text.
 */

import { copy } from '../copy';
import type { CollabStatus } from './provider';
import type { Peer } from './useCollab';

function initials(name: string): string {
  if (name.startsWith('🤖')) return '🤖';
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
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
      <span className={`presence-status presence-${status}`}>
        {status === 'live' ? copy.collab.live : status === 'offline' ? copy.collab.offline : copy.collab.connecting}
      </span>
    </div>
  );
}
```

In `web/src/copy.ts` add:

```ts
  collab: {
    live: 'Live',
    offline: 'Offline — your changes will be sent',
    connecting: 'Connecting…',
    unavailable: 'Live editing unavailable — saving as usual',
    moved: (path: string) => `This note was moved to ${path}`,
    deleted: (by: string) => `This note was deleted by ${by}`,
  },
```

In `web/src/styles.css`, next to the save indicator styles:

```css
.presence { display: inline-flex; align-items: center; gap: 4px; }
.presence-mark {
  width: 22px; height: 22px; border-radius: 50%;
  display: inline-grid; place-items: center;
  font-size: 11px; font-weight: 600; color: #0b1418;
}
.presence-status { font-size: 12px; color: var(--muted); margin-left: 6px; }
.presence-offline { color: var(--warn); }
```

(Use the token names the file already defines for muted and warning text; check the top of `styles.css`.)

- [ ] **Step 5: App wiring**

In `web/src/App.tsx`:

1. Import `useCollab` and `Presence`.
2. After the `useNoteBuffer` block, add:

```ts
  const collab = useCollab(openRef, collabEnabled, {
    onMoved: (owner, path) => {
      setOpenRef({ owner, path });
      pushRecent(user.id, owner, path);
      setRecents(loadRecents(user.id));
      invalidate.afterStructure(client);
      setError(copy.collab.moved(path));
    },
    onDeleted: (by) => {
      discard();
      setOpenRef(null);
      setView('home');
      invalidate.afterStructure(client);
      setError(copy.collab.deleted(by));
    },
    onGone: () => {
      discard();
      setOpenRef(null);
      setView('home');
    },
  });
  const live = collab.provider !== null && collab.synced && collab.status !== 'unavailable';
```

Declare `const collabEnabled = true;` next to it. The server's kill switch shows up as `unavailable` (the socket route does not exist, the upgrade fails twice). If `setView('home')` is not the name of the home view in this file, use the value `prefs.startView` falls back to.

3. At the `<Editor` (line ~2024): pass

```tsx
                    collab={live ? { text: collab.provider!.text, awareness: collab.provider!.awareness } : null}
                    readOnly={live ? !collab.canWrite : !open.canWrite}
                    locked={deletingKeys.has(refKey(open.owner, open.note.path)) || (collab.status === 'connecting' && collabEnabled)}
                    onChange={(content) => {
                      if (!live) scheduleSave(open.owner, open.note.path, content);
                    }}
```

keeping every other prop. The `locked` addition keeps the REST text visible and untypeable during the first sync (spec: "shown immediately, locked").

4. At `<SaveIndicator state={saveState} />` (line ~1938): render

```tsx
                {live || collab.status === 'offline' ? (
                  <Presence peers={collab.peers} status={collab.status} />
                ) : (
                  <>
                    <SaveIndicator state={saveState} />
                    {collab.status === 'unavailable' && openRef !== null && (
                      <span className="presence-status">{copy.collab.unavailable}</span>
                    )}
                  </>
                )}
```

5. Delete confirmation, rename dialog and history restore keep working unchanged: they go through REST, the server routes them into the room, and the provider receives the change.

- [ ] **Step 6: Run the whole web suite and typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS, including `one-language.test.ts` (all new copy is English) and the existing editor round-trip tests.

- [ ] **Step 7: Commit**

```bash
git add web/src web/test/editor-collab.test.ts web/test/presence.test.tsx
git commit -m "feat(web): live editor with cursors, presence and fallback"
```

---

### Task 10: End-to-end check, documentation, rollout

**Files:**
- Modify: `README.md` (architecture section, *What is not built*, single process)
- Modify: `docs/superpowers/specs/2026-09-28-live-collab-design.md` (status line)
- ndBrain note `10_Projects/11_Active/ndBrain.md` (via MCP, not in the repo)

- [ ] **Step 1: Full test run**

```bash
cd server && npm test && npm run typecheck && npm run smoke
cd ../web && npm test && npm run typecheck && npm run build
```

Expected: all PASS, build succeeds.

- [ ] **Step 2: Manual run, locally**

```bash
cd server && NDBRAIN_DATA_DIR=/tmp/ndbrain-collab NDBRAIN_COOKIE_SECURE=false npm run build && node dist/server/src/main.js
```

(Check `server/package.json` / `Dockerfile` for the exact start command and use that.) Create `julian` and `testfreigabe` with `ndbrain-user`, share one folder read-write with `testfreigabe`, and create an agent key for `julian`. Then check, in two browsers (one per account) plus one MCP client:

1. Both see each other's cursor with name; typing appears in the other within a second.
2. The MCP client runs `append_note` and `edit_note` on the open note: the text appears live, with a `🤖 <key>` marker for about five seconds, and no conflict copy appears in *Tidy up*.
3. ⌘Z in one browser does not undo the other's typing.
4. Rename the note from the second browser: the first keeps typing, and the text lands in the renamed note.
5. Stop and start the server while both type: after reconnecting, no text is doubled and offline typing is there.
6. With `NDBRAIN_COLLAB=false`: the editor shows "Live editing unavailable — saving as usual" and saving works as before.

Write down anything that deviates; it is fixed before continuing.

- [ ] **Step 3: README**

In the architecture section of `README.md`:
- Add `collab/` to the module table: "Live rooms for open notes: an in-memory Yjs document per note, synced over `/api/v1/collab`, persisted through `NoteService`. No CRDT state is stored."
- Rewrite "How changes reach the browser": live notes sync over a WebSocket; the pulse remains for the brain and activity views; notes open without a socket fall back to the conflict-copy behaviour.
- In *What is not built*: "No offline editing beyond a short disconnect" and "One process: rooms live in memory, so ndBrain does not run behind a load balancer with several instances."
- In *Running it*: the reverse proxy must pass WebSocket upgrades; `NDBRAIN_COLLAB=false` turns live collaboration off.

- [ ] **Step 4: Commit and push the branch**

```bash
git add README.md docs/superpowers/specs/2026-09-28-live-collab-design.md
git commit -m "docs: live collaboration in the README"
git push origin feat/live-collab
```

- [ ] **Step 5: Project note**

With `mcp__ndbrain__edit_note` on `10_Projects/11_Active/ndBrain.md`: under "Entscheidungen, die gelten", mark the "Kein CRDT" bullet as superseded (date 2026-09-28, reason: all three collaboration cases wanted; the files stay the truth because the CRDT only lives in memory) and add a dated entry with what was built. German, per the vault's writing rules.

- [ ] **Step 6: Rollout (only on Julian's explicit go)**

1. In Nginx Proxy Manager, proxy host 24: check that *Websockets Support* is on; switch it on if not.
2. Merge `feat/live-collab` into `main`.
3. Deploy with the command from the CT 132 note (read it fresh; do not type it from memory), building without `-q`.
4. Check `https://ndbrain.b8n.ch/api/v1/health` and open one note in two browsers.
