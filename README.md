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
**Not usable yet** — there is no server process and no UI. Do not deploy this.

| Phase | | |
|---|---|---|
| 0 | Vault core — path safety, tenant boundary, Markdown parsing, single write path | done |
| 1 | Index — SQLite + FTS5, link resolution, file watcher, reconciliation | done |
| 2 | REST API, authentication, minimal web UI | next |
| 3–6 | Search, backlinks, overview, tidy-up tools | planned |
| 7 | Sharing between users | planned |
| 8 | PWA and desktop shell | planned |
| 9 | MCP endpoint with scoped keys | planned |

## Layout

```
server/    Node + Fastify, TypeScript. Vault access, index, REST, MCP.
web/       React + Vite UI (phase 2).
desktop/   Tauri v2 shell (phase 8).
```

## Multi-tenant from the ground up

Every user gets their own vault directory. This is a security boundary, not a convenience:
ndBrain is meant to be self-hosted by strangers, so one user must never be able to reach
another's notes — not through a path, not through search, not through a wikilink, and not
through the difference between "not found" and "not allowed".

The vault layer has no function that does not take an owner, and every index row carries one.

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

## Development

```bash
cd server
npm install
npm test          # unit and integration tests
npm run typecheck
npm run smoke     # builds a realistic vault, asserts byte-identical reads and no tenant leak
```

Requires Node 22 or newer. There is no native dependency: SQLite comes from Node's built-in
`node:sqlite`, deliberately, so that self-hosting never requires a C++ toolchain.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

There is no API stability promise while the version is `0.x`. Security boundaries are not covered
by that caveat: those are treated as requirements, not as work in progress.
