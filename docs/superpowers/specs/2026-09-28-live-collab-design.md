# Live collaboration on a note

Status: design approved 2026-09-28, implemented 2026-09-30 on `feat/live-collab`, not yet deployed.

Where the implementation departs from this design, and why, is in the commit messages on that
branch; the three places worth knowing are the origin check (`request.protocol` is undefined on a
WebSocket upgrade), the per-account socket cap (refused at the HTTP layer, and counted as a
reservation rather than off the connection set) and the permission re-check (coalesced, because
`node:sqlite` is synchronous).

## Why

Today two editors on the same note overwrite each other: the later save lands, the earlier text
becomes a conflict copy, and nobody sees the other person typing. An agent writing through MCP
into a note that is open in the browser produces the same conflict copy. Nothing is lost, but
working on one note at the same time is not possible.

Three cases must work live, with text, cursors and names:

1. **Several people** on one note, through a space or a share.
2. **One person on several devices or tabs.**
3. **A person and an agent**: an MCP write into an open note appears in the editor, at the place
   it happened, labelled with the agent's key name, without a conflict copy.

## Decision this replaces

The project decisions said *no CRDT*: last-writer-wins plus a conflict copy was enough because
human and agent never write into the same paragraph at the same time. That no longer holds for
the three cases above. What stays untouched is the decision that binds all others:
**the `.md` files are the only truth.** The CRDT in this design is a working tool in memory while
a note is open. No CRDT state is ever written to disk or to the database, so the index stays a
cache and migration stays copying a folder.

## Non-goals

- Offline editing beyond a short disconnect while the room still exists.
- More than one server process. Rooms live in the memory of the one process, like the watcher.
- Collaboration on anything but note text (no live tree, no live rename dialog).
- Comments, suggestions or a per-character authorship view.

## Overview

```text
browser tab ──ws──┐
browser tab ──ws──┤                ┌──────────── Room (owner:path) ────────────┐
                  ├─ /api/v1/collab ─▶ Y.Doc / Y.Text   epoch   lastPersisted  │
MCP / REST ───────┼─ App ──────────▶ transform(fn)                            │
watcher (disk) ───┘                │   └─ debounced persist ─▶ NoteService.put ─┼─▶ vault/*.md
                                   └────────────────────────────────────────────┘
```

A room exists while at least one editor has the note open. Every change to the note's content,
from any source, goes through the room while it exists, and through today's paths when it does
not.

## Server

### Server units

| File | Responsibility |
| --- | --- |
| `server/src/collab/room.ts` | One open note: `Y.Doc` with one `Y.Text` named `content`, `epoch` (random id, new per room instance), `lastPersisted` (`{ text, hash }`), connected clients, persist timer. |
| `server/src/collab/rooms.ts` | Registry keyed by `owner:path`. `open`, `get`, `rekey` (rename), `close`, limits. |
| `server/src/collab/socket.ts` | WebSocket route `GET /api/v1/collab`, `y-protocols` sync and awareness, origin check, permission checks, limits. |
| `server/src/collab/merge.ts` | `minimalDiff(from, to)` into Y operations, and `threeWay(base, incoming, live)` with `fast-diff` and `node-diff3`. Pure, no I/O. |

### The one door: `room.transform`

A room offers exactly one way to change its text:

```ts
transform(fn: (live: string) => string, origin: Origin): TransformResult
```

`fn` runs on the current live text. The result is expressed as the minimal diff from the live text
to the new text and applied to the `Y.Text` in one Yjs transaction, then broadcast. Because the
diff is computed against the live text at that instant, it is exact. `origin` names who changed it
(`{ kind: 'user', id }` or `{ kind: 'agent', keyId, keyName }`) and is used for the edits log,
for undo scoping in the browser and for agent presence.

### Routing writes

Every method on `App` that changes a note's content asks the registry first. If a room is open for
`owner:path`, the change goes through `transform`; otherwise it runs as today.

- **Read-modify-write operations become `transform` functions unchanged in meaning:**
  `appendNote` (REST quick capture and MCP `append_note`), `toggleTask`, `bulkTag`, `bulkUntag`,
  `applyTopics`, the link rewrite in `renameNote` and `renameFolder`, and MCP `edit_note`.
- **Whole-text writes with a base are three-way merges:** `putNote` with a `baseHash` from a
  client not in the room (an old tab, the fallback mode), and a restore from history. For
  `putNote`, the base is the text the `baseHash` names: `lastPersisted` if it matches, otherwise
  the version read from the history sidecar; if neither is available the incoming text is treated
  as a conflict and kept as a copy, as today. A restore is `transform(() => restoredText)`:
  it replaces the text on purpose and is undone by another restore.
- **Changes on disk** (vim, rsync, `git checkout`) reported by the watcher's `onNoteChanged`:
  if the file's hash differs from `lastPersisted.hash`, it is a three-way merge with base
  `lastPersisted.text`, incoming the file content, live the room text. `lastPersisted` then moves
  to the file content.
- **Three-way merge:** `fast-diff` computes the character diff base → incoming, and `node-diff3`
  merges it against the live text. Hunks that apply are merged through `transform`. If any hunk
  fails, the incoming text is written out as a conflict copy exactly as today, so a failed merge
  never loses text. diff3 recognises the same change made on both sides, which a patch applier
  would insert twice.

### Persisting

The room writes its text through `NoteService.put` with `baseHash = lastPersisted.hash`, at most
one second after the last change, before any structural operation on the note (rename, move,
delete) and when the last client leaves. Lock, index, edits log, note bindings, history and
backup are therefore unchanged. The watcher sees the room's own write, finds the same hash as
indexed and does nothing.

If the file changed on disk between two persists, the persist's `baseHash` does not match. The
room does not write over it: it first runs the disk change through the three-way merge above,
then persists the merged text.

Each persist records one edits-log row per actor that changed the room since the previous
persist: the account for a person, the key name for an agent, as today.

### Agent presence

Agents have no socket. When `transform` runs with an agent origin, the room sets a server-owned
awareness entry `{ name: '🤖 <key name>', color, cursor at the end of the changed range }` and
removes it after five seconds without further agent writes.

### Structural changes while a room is open

- **Rename or move** (single, bulk, folder rename): persist, run the rename as today, then
  `rooms.rekey(old, new)`. Clients receive a `moved` message with the new owner and path.
- **Delete:** the room persists once more first, so *Recently deleted* holds the last text, the
  delete runs as today, the room closes and clients receive `deleted` with the account name.
  Recovery is *Recently deleted*.

### Permissions during a session

- On join, `shares.check(caller, owner, path, 'read')` decides whether the socket is accepted,
  and a `'write'` check decides whether it may send updates. A refused join answers exactly like
  a missing note.
- Share withdrawn or downgraded, account disabled, password changed, logout: the code paths that
  perform these changes notify the registry, which re-checks every socket of the affected callers
  and closes it or drops it to read-only. As a backstop every socket re-validates its session and
  permission every 60 seconds.
- Updates from a read-only socket are discarded by the server, whatever the client claims.

### Socket security and limits

- **Origin check on upgrade.** The socket authenticates with the session cookie, which browsers
  also send on cross-site WebSocket upgrades. An upgrade whose `Origin` is not the server's own
  public origin is refused with 403.
- **Awareness is sanitised.** The server overwrites `name` and `color` in every awareness update
  with values derived from the session. The robot prefix is reserved for server-owned entries.
- **Limits:** message size 8 MiB (a large note's first sync must fit), an update rate limit per
  socket, 20 sockets per account, 200 open rooms per process. Exceeding a limit closes the socket
  with a distinct close code; the client falls back to today's mode for that note.

### Configuration

`NDBRAIN_COLLAB` (default `true`). With `false` the route is not registered and every client runs
in today's mode. This is the kill switch, no code rollback needed.

### Server dependencies

`yjs`, `y-protocols`, `lib0`, `@fastify/websocket`, `fast-diff`, `node-diff3`. All pure JavaScript;
`ws` works without its optional native add-ons, so the no-toolchain install rule holds.

## Browser

### Browser units

| File | Responsibility |
| --- | --- |
| `web/src/collab/provider.ts` | WebSocket to `/api/v1/collab?owner=…&path=…`, `y-protocols` sync and awareness, reconnect with backoff, `epoch` handling, server messages (`moved`, `deleted`, `readOnly`). |
| `web/src/collab/useCollab.ts` | Hook returning `{ doc, text, awareness, status, peers }` for the open note, or `null` in fallback mode. |

### Editor

`Editor.tsx` takes an optional `collab` prop. With it, the document comes from the `Y.Text`
instead of `initialContent`, `y-codemirror.next` is added as an extension, and CodeMirror's
`history()` is replaced by `Y.UndoManager` scoped to the local origin, so undo only reverts the
tab's own changes. Live preview, tables, completion and vim mode stay, since they sit on
CodeMirror state only.

### Opening a note

The note is fetched over REST as today (text, rights, hash) and shown immediately, locked. The
provider connects in parallel; after the first sync the editor unlocks with the room's text.

### Presence

- One awareness entry per tab: display name and a colour derived from the account id, so one
  person's devices share a colour.
- Remote cursors and selections with name labels, rendered by `y-codemirror.next`.
- A row of initials in the note header listing who is present, agents included.
- The save indicator shows `Live`, or `Offline, your changes will be sent` while disconnected.

### Disconnects

- **Same epoch on reconnect:** local edits made while offline are in the local `Y.Doc`; Yjs sync
  merges them.
- **Different epoch** (the room was recreated, for example after a server restart): merging Yjs
  state would duplicate the whole text, because both sides inserted the initial text as their own
  operations. The client instead sends its text with the last text the server acknowledged as base
  to the three-way path (`PUT` with that base's hash), then discards its `Y.Doc` and rejoins.
- **Tab closing with unacknowledged changes:** the same three-way `PUT` with `keepalive`, within the
  existing 60 KiB budget, from the existing `pagehide` and `beforeunload` handlers.
- **No socket at all** (proxy blocks upgrades, kill switch, limit hit): the note runs in today's
  mode through `useNoteBuffer` with `baseHash`, with a note in the header that live collaboration
  is unavailable.

### Browser dependencies

`yjs`, `y-protocols`, `y-codemirror.next`.

## Testing

Server (vitest):

- `merge.ts`: minimal diff reproduces the target byte for byte, including emoji, CRLF and NUL;
  a property test over random text pairs. Three-way merge: disjoint changes merge, overlapping
  changes produce a conflict copy.
- Concurrency: two simulated clients typing, an agent append and a `toggleTask` at the same time
  converge, and the file on disk equals the converged text after persist.
- Disk edit while a room is open: merged without overlap, conflict copy with overlap. An old tab's
  `putNote` with `baseHash` behaves the same.
- Epoch change: a client with unacknowledged edits after a room restart ends without duplicated
  text.
- Persist: the watcher ignores the room's own write; the last client leaving persists and closes.
- Security: foreign origin gets 403; updates from a read-only socket are discarded; a withdrawn
  share closes the socket with a response identical to a missing note; a forged awareness name is
  overwritten; size, rate and count limits close the socket.
- Structure: rename and delete with an open room.
- `concurrency.test.ts` and the MCP append tests are updated where their promise of a conflict copy
  no longer applies to a note with an open room; the promise stays for notes without one.

Browser (vitest + testing-library):

- Provider: reconnect, epoch change, fallback when no socket connects.
- Editor with `collab`: undo reverts only local changes; read-only locks input.

Before deploy, a manual run locally: two browsers (own account and `testfreigabe` on a shared note)
plus an agent over MCP writing into the same note, checking cursors, names, undo, rename during
a session and a server restart during a session. `npm test`, `npm run typecheck` and
`npm run smoke` in `server/`, `npm test` in `web/`.

## Rollout

1. Check or enable *Websockets Support* on the Nginx Proxy Manager host in front of the instance.
2. Deploy only on explicit approval.
3. Update the README (architecture section, *What is not built*, single-process note) and mark
   the *no CRDT* decision in the project notes as superseded, with date and reason.
