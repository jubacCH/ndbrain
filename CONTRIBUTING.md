# Contributing

Issues and pull requests are welcome. This file is short, and most of it is
about one thing: what a change to this codebase is expected to come with.

## Running it

Two npm projects and one Rust workspace, no monorepo tooling:

```bash
cd server && npm ci && npm test        # ~1,500 tests
cd web    && npm ci && npm test        # ~1,100 tests
cd desktop && cargo test               # ~90 tests, macOS only
```

Node 24, because that is what the image ships. The database is `node:sqlite`,
which is young enough that its behaviour differs between Node releases, so a
green run on another version proves less than it looks like.

`npm run typecheck` in either project, and `npm run build` in `web/` — the web
build is a check as well as a build: it runs `scripts/check-csp.mjs`, which
reads the bundle and fails if anything in it evaluates a string.

CI runs all of this on every pull request.

## What a change is expected to come with

**A test that fails without it.** Not coverage — a test that would have caught
the thing. The pattern through this codebase is to write it first, watch it
fail for the right reason, then make it pass.

**And a check that the test is real.** Take the change out again and watch the
test go red. A surprising number of tests pass because they are asserting
something that was already true; this project has found several of its own that
way, and the practice has a name in the commit history: *mutation*. If a test
survives its own mutation it is not yet a test.

**Comments that say why, not what.** The code says what it does. A comment
earns its place by recording the thing a reader cannot recover: the alternative
that was tried and failed, the constraint that forces this shape, the bug that
this line prevents. Several of them in here are the only record of an outage.

**Words in one place.** Everything a person reads lives in `web/src/copy.ts` and
`desktop/app/src/copy.rs`. A test enforces that components hold no prose, which
is what makes it possible to say that the interface speaks one language.

## Shape of the thing

A few decisions are load-bearing, and a change that works against them will be
hard to land however good it is:

- **The files are the truth.** The database is a cache that can be deleted and
  rebuilt from the vault, and a test enforces it. Anything that cannot be
  recovered from the Markdown has to be in the small set of tables that are
  deliberately not derivable — accounts, shares, agent keys, the edit log.
- **One write path.** Everything that changes a note goes through the same
  place, under the same lock, so that sharing, history and the index cannot
  disagree about what happened.
- **A refusal looks like an absence.** Asking for something you may not have
  answers exactly as asking for something that is not there — the same status,
  the same body. If the two can be told apart, the difference is itself
  information somebody was not granted.
- **No self-registration.** Accounts come from `ndbrain-user` and nowhere else.

The architecture section of [README.md](README.md) is longer and worth reading
before a change that crosses module boundaries.

## Commits

A commit message explains the change to somebody who will meet it in `git blame`
in two years with no other context: what was wrong, why this is the fix, and
what was considered and rejected. The history here is long-form on purpose.

## Cutting a release

```bash
# 1. Move the Unreleased section of CHANGELOG.md under the new number, commit.
# 2. Tag it. The tag is what publishes; nothing else does.
git tag -a v0.1.0 -m "0.1.0" && git push origin v0.1.0
```

`.github/workflows/release.yml` then runs the whole test suite, builds the
image for `linux/amd64` and `linux/arm64` on native runners, and tags both under
one name in GHCR. It publishes nothing if the suite fails: an image built from a
commit nothing verified is worse than no image, because somebody else runs it.

**The first release needs one thing done by hand.** A package GHCR has never
seen is created private, so the first push makes an image nobody can pull. Make
it public under the repository's *Packages*, once; after that every release
inherits it.

Versions are `0.x` while the API can still change. The database migrates itself
forward on start and there is no path back, so a release is also a thing people
restore a backup to undo — which is why there is no floating `:1` tag.

## Security

Please do not open a public issue for a vulnerability — see
[SECURITY.md](SECURITY.md).
