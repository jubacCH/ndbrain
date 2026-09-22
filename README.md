# ndBrain

A self-hosted notes server that is a **librarian, not a better editor**.

Notes are plain Markdown files in a folder. The server indexes them, resolves `[[wikilinks]]`,
and tells you what is drifting: orphaned notes, untagged notes, dead links, notes nobody has
touched in months. Humans use the web UI; agents use MCP with scoped keys. Both read and write
the same files.

**Migration is copying a folder.** The database is a cache and can be rebuilt from the files at
any time — that is the core promise, and it is enforced by a test rather than asserted in a README.

## Status

Rebuilt from scratch in July 2026, replacing an earlier version that grew too large to finish.
The rebuild ran to the end of its plan, and the result has been in daily use since August 2026:
one instance behind a reverse proxy, holding real notes, with agents writing into them over MCP.

| Phase | | |
|---|---|---|
| 0 | Vault core — path safety, tenant boundary, Markdown parsing, single write path | done |
| 1 | Index — SQLite + FTS5, link resolution, file watcher, reconciliation | done |
| 2 | REST API, authentication, web UI, container image | done |
| 3–6 | Search, backlinks, overview, tidy-up, graph views, home, journal and daily notes | done |
| 7 | Sharing between users | done |
| 8 | Installable as an app (PWA) | done; the desktop shell was never built, see below |
| 9 | MCP endpoint with scoped agent keys | done |

Three releases came after the plan ran out: spaces (vaults nobody signs in to), bringing back a
deleted note, and putting the history and backup layer that had only ever lived on the hosts
into this repository as `ops/`.

## Running it

The container image builds from this repository and carries no native dependency.

```bash
docker compose up -d
docker compose exec ndbrain ndbrain-user create julian --admin
```

There is no self-registration: `ndbrain-user` is the only way an account comes into existence,
and it reads passwords from stdin rather than from an argument that would land in `ps`. Run it
with no arguments for the rest — passwords, agent keys, spaces, reindex.

The vault and the index live on the host (`/srv/ndbrain/vaults` and `/srv/ndbrain/index` in
`docker-compose.yml`), so removing the container can never take notes with it. TLS is expected to
be terminated by a reverse proxy in front; `NDBRAIN_COOKIE_SECURE=false` is for a plain-HTTP test
and nothing else, because the browser will otherwise drop the session cookie. The remaining
settings and their defaults are in `server/src/config.ts`, which is short on purpose.

## Layout

```
server/    Node + Fastify, TypeScript. Vault access, index, REST, MCP.
web/       React + Vite UI, installable as an app.
shared/    The API schemas both sides compile against.
ops/       History and backup on the hosts — see ops/README.md.
```

`ops/` is the layer that protects ndBrain from data loss: a timer that commits each vault into a
git repository beside it, a database snapshot, and a pull from the backup host. It is documented
in [ops/README.md](ops/README.md), in German like the scripts themselves, because its reader is
the operator and not the compiler.

## Multi-tenant from the ground up

Every user gets their own vault directory. This is a security boundary, not a convenience:
ndBrain is meant to be self-hosted by strangers, so one user must never be able to reach
another's notes — not through a path, not through search, not through a wikilink, and not
through the difference between "not found" and "not allowed".

The vault layer has no function that does not take an owner, and every index row carries one.

## Sharing: vaults, folders, notes and spaces

Sharing splits "owner" into two things that stay apart: the **caller** making the request, and
the **owner** whose vault the note lives in. Every vault and index function still takes the
owner; a gate in front decides which owners a caller may reach and how. The boundary above is
therefore not weakened by sharing, it is the same boundary with an explicit, revocable list of
doors in it.

A share covers a whole vault, one folder, or exactly one note. The three cases are one rule in
one function, `inScope`, with a SQL twin beside it that every query filters on, and a test that
asks both about the same paths so the two cannot drift apart unnoticed. A refusal is always
"does not exist", never "not allowed": a caller who can tell those apart can map out the parts of
a vault they were never shown.

A **space** is a vault that belongs to nobody. Nobody signs in as one and it has no password;
an administrator creates it and adds members, who see it beside their own vault. It is where
notes live that are not one person's — a household, a team, a shared project.

A write-shared note has real conflicts, and the answer is last-writer-wins. The incoming text
lands, the version it displaced is written out beside it as a conflict copy and indexed like any
other note. Nothing is merged: a merge that gets it wrong is worse than two files, because it
looks finished.

## Agents

`POST /mcp` is a general MCP endpoint, not one integration. Any client can point at it — Claude
Desktop, an editor plugin, somebody else's agent.

Access is a key, not an account. A key belongs to an owner and may narrow further, by path scope
and by a read/write flag, so a key can only ever see less than its owner and never more. Every
call is checked twice, against the owner's vault boundary and against the key's own scope. The
secret is shown once and stored only as a SHA-256 hash, and every tool call is logged, so the
owner can see what their agents actually did.

The tools are `search_notes`, `get_note`, `list_notes`, `vault_map`, `get_links`, `list_tasks`,
`create_note`, `append_note`, `edit_note`, `rename_note` and `delete_note`. An agent that can only
ever add makes tidying work it cannot take part in, so it can clear up after itself too — a delete
through MCP lands in *Recently deleted* like any other, and `delete_note` says in its answer
whether a saved version to bring back actually exists.

## Design notes worth knowing before reading the code

- **Case-sensitivity is checked against real directory entries, never `stat`.** `stat` folds case
  on Windows and macOS but not on Linux, so the same code would otherwise take a different branch
  per platform. Two notes whose names differ only in case are refused, because that pair cannot
  survive being copied onto either of those systems.
- **Change detection compares content hashes, not timestamps.** A restore, a `git checkout` or an
  rsync can leave a changed file with an older mtime.
- **The file watcher is for latency, not correctness.** Watchers lose events — inotify limits,
  network shares, and write-settling that withholds a file created and deleted inside its window.
  A periodic reconciliation pass is what actually guarantees the index matches the vault.
- **Unresolved links are kept.** A link into the void is a finding to report, not an error to discard.

## Note shares and editing files outside ndBrain

A note share grants another user (or an MCP key) access to one specific note. That grant is bound
to the file itself, not just its path: the share is confirmed against the file's identity and
content hash before every read and before every write ndBrain makes to that path. This is a
security boundary, not an implementation detail — a path alone cannot prove that the file behind
it is still the note the owner meant to share, so ndBrain refuses to carry a grant across a file
it cannot vouch for.

This means a note share is withdrawn when a file is externally replaced rather than edited in
place — for example when an editor deletes the file and writes a new one at the same path on save.
**vim does this by default.** Add `set backupcopy=yes` to your vimrc so vim edits the existing file
instead of replacing it, and shares on notes you edit with vim survive the save. VS Code, nano and
Obsidian all edit in place and are unaffected.

If the replacement file's content is at least 64 bytes of non-whitespace and matches what the
share was bound to, ndBrain treats it as the same note restored (a `git checkout`, a copy from
backup) and keeps the share. Below that size the rescue is not reliable enough to trust, so the
share is withdrawn.

## What is not built

Worth knowing before reading the code, because some of it is conspicuous by its absence.

- **No AI anywhere in the product.** Not an embedding, not a model call, not a semantic search.
  `grep -rniE 'embedding|openai|anthropic' server/src web/src shared` returns nothing, and that is
  the honest state rather than an oversight waiting to be fixed. Search is SQLite FTS5 over title
  and body plus the link structure; the brain view is a layout of that link graph, not a model.
  Agents come to ndBrain through MCP and bring their own intelligence with them.
- **No desktop shell.** Phase 8 planned a Tauri v2 application beside the PWA. Only the half that
  could be verified was built, so ndBrain installs to a home screen or a taskbar from the browser
  and there is no `desktop/` directory.
- **No offline notes.** The service worker exists for startup speed and installability. Anything
  under `/api/` never touches the cache in either direction, because serving a cached note would
  be showing somebody text that may have changed with no way for them to tell.
- **No history of its own.** The version history and the way back from a delete are read out of
  the git repository that `ops/vault-history.sh` maintains beside each vault on the host. ndBrain
  only reads it: the timer owns every commit, so a git that is broken or missing degrades the
  history view to "not available" and cannot stop a note from being saved. Without that timer
  there is no history at all.
- **No backup inside the application**, and the layer that does it has its own limit written
  down in [ops/README.md](ops/README.md): up to two minutes of writing is not covered by it.
- **No sign-up, no email, no second factor.** An administrator creates accounts, and a forgotten
  password is reset by one. There is nothing in here that sends mail, so there is no reset link
  to send.

## Development

```bash
cd server
npm install
npm test          # unit and integration tests
npm run typecheck # npm test does not typecheck
npm run smoke     # builds a realistic vault, asserts byte-identical reads and no tenant leak
```

The UI has its own suite in `web/` (`npm install && npm test`), and `npm run dev` there serves
the interface against a server started separately on port 3000.

Requires Node 22 or newer. There is no native dependency: SQLite comes from Node's built-in
`node:sqlite`, deliberately, so that self-hosting never requires a C++ toolchain.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

There is no API stability promise while the version is `0.x`. Security boundaries are not covered
by that caveat: those are treated as requirements, not as work in progress.
