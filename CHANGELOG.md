# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[semantic versioning](https://semver.org/).

**This file starts here.** ndBrain was rebuilt from scratch in July 2026 and ran
for its first months without releases, as one instance its author deployed from
`main`. Four hundred commits of that are in `git log`, where they are written at
length; inventing a changelog for them after the fact would be a worse record
than the one that exists. Releases — and this file — begin with the first tag.

A note on what a version means here: ndBrain migrates its database on start,
forwards only. Upgrading is pulling a newer image; downgrading is restoring a
backup. Take a copy of `data/index/ndbrain.db` before an upgrade, with
`sqlite3 … ".backup"` rather than `cp`.

## [Unreleased]

### Added

- **An account is identified by something nobody chose.** A random `acc_…`
  identifier that is written once, with the login name and the display name as
  separate things that can both be changed freely. Before this one readable name
  did all three jobs, so none of them could move. An account can now be renamed.
- **A right-click menu on every row of the folder tree**, offering what that row
  allows and opening on nothing a reader may not act on. Renaming and deleting
  were already there as F2 and Delete and were findable nowhere.
- **Folders inside a space**, which were never possible: the route had taken an
  owner and checked it from the start, and the client never sent one.
- **A Mac client** (`desktop/`): a window on ndBrain plus a global shortcut that
  puts a thought into today's note from inside whatever else is in front.
- **Live collaboration** between open tabs, over a WebSocket, with the server
  holding the shared document. Off with `NDBRAIN_COLLAB=false`.
- **Agent keys that a person makes for themselves**, in their own settings.
  An administrator no longer sees them: a key is that person's business, and
  the lever that remains is disabling the account, which stops its keys too.
- **Folded frontmatter** while nobody is editing it.
- CI on every push and pull request, and a published image for `linux/amd64`
  and `linux/arm64`.

### Changed

- **"Whole network" is linear rather than quadratic.** The repulsion in the
  graph layout applied no force past a cutoff but measured every pair anyway; at
  three thousand notes that was nine million comparisons for seventeen thousand
  that mattered.
- Bulk actions ask in a dialog instead of `window.prompt`, which could not check
  a folder path or tell you why a tag would never be found again.
- Every owner is named by their display name, not by their account name.

### Fixed

- **A vault's history could not be read for any account but one.** The timer
  that commits it runs as root and the application reads it as another user, so
  git refused with "dubious ownership" — and the application reported a defect
  rather than an absence.
- **A folder with nothing in it was not a row in the tree**, so making one
  looked exactly like a menu entry that does nothing.
- **A note open in a live room warned that somebody else had changed it** and
  offered to replace the text with itself.
- The content security policy promised that nothing in the bundle evaluates a
  string. It had stopped being true, and nothing checked; now the build does.
- The Mac client's window opened behind whatever was in front of it.
