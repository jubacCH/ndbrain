# Acceptance runs for live collaboration

Three scripts that drive a **running** ndBrain over a real WebSocket and check
what unit tests cannot: whether two sessions on one note actually converge,
whether what they agree on is what lands in the file, and whether a note survives
a rename, a dropped connection and a server restart.

They exist because live collaboration has no CI, and because the promises they
check are the kind whose failure looks like nothing until somebody loses a
paragraph.

## Running them

Nothing names a host or an account. The password comes from stdin — never an
argument, which would land in shell history and in `ps`, the same rule
`ndbrain-user` follows.

```bash
cd web
NDBRAIN_URL=https://notes.example NDBRAIN_USER=somebody \
  node acceptance/two-sessions.mjs <<< 'the-password'
```

From `web/`, so the imports resolve against its `node_modules`. `NDBRAIN_URL`
defaults to `http://127.0.0.1:3000`.

| Script | What it covers | Needs |
|---|---|---|
| `two-sessions.mjs` | two sessions seeing each other, the file matching both, a rename while both are open | nothing |
| `reconnect.mjs` | a dropped connection, text typed offline, returning to a room that moved on | nothing |
| `restart.mjs` | a server restart mid-session, the rebuilt room, the rebase | **you** restart the server when it asks |

Each creates one throwaway note in the account it signs in as and deletes it at
the end — including when it gives up waiting. They write to a real vault: run them
against an account whose notes you do not mind, or accept that the throwaway note
appears in the history and in "Recently deleted" for thirty days.

## Why they import `yjs` instead of speaking the protocol by hand

Because a hand-rolled client can fail in a way that looks like a product defect.
That is not hypothetical: the first version of `restart.mjs` reconnected by
syncing its old document into the rebuilt room, which inserted the whole note a
second time — and reported it as duplication in the server. The real browser
refuses exactly that.

Two parts of `web/src/collab/provider.ts` are therefore mirrored in
`session.mjs`, and leaving either out makes these scripts lie:

- **nothing is sent before the hello**, because the hello says which room this is
- **a document from an earlier epoch is never synced into a new room** — the
  reconnect reports `rebase` instead, which is where the browser hands the text to
  the ordinary save path and starts over

## What they do not cover

Whether two cursors and two names appear in the editor. That needs an eye, and
it is the half of the acceptance run that stays manual: two browser windows on
one note, both names visible, `⌘Z` in one window never undoing the other
window's typing.
