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

- **Task lists, on the server.** A list is a `<List name>.tasks.json` file
  anywhere in the vault, with its own statuses and tasks that carry a status,
  priority, assignees, start and due dates, tags, a description, a parent and
  a position. `GET`/`POST /api/v1/tasklists/*` read and create a list;
  `POST`/`PATCH`/`DELETE /api/v1/tasklist-items/*` add, change and remove
  tasks, field by field. Folder, vault and space shares cover the lists in
  them like any other file. No interface yet; that is the next step. Design:
  `docs/superpowers/specs/2026-10-25-task-lists-design.md`.

## [0.3.0] — 2026-10-25

Tables you can change the shape of, and people you can mention. Both stay
Markdown: a table is a GFM table and a mention is an ordinary link.

### Added

- **Tables edited the way AFFiNE edits them.** A handle on every row and
  column appears with the pointer: click it to insert, move, align (columns),
  duplicate, clear or delete; drag it to move the row or column. Bars under
  and beside the table add a row or a column. Arrow keys walk the cells and
  carry on into the text above and below; a table that ends the note gets a
  line after it. Drag across cells, or use Shift, to pick a range, which
  Delete clears and copy or cut take as tab-separated text. A block pasted
  from a spreadsheet fills the cells it lands on and grows the table where it
  reaches past it. Right click, or Shift+F10, opens the same menu on a cell.
  The first row is a row like any other: moving or deleting it makes another
  row the header. Column widths are not offered, since GFM cannot store them.
- **`@` mentions a person.** The menu offers the people this client already
  knows — owners whose notes it can see and, for an administrator, every
  account — never inside a word, so an e-mail address stays text, and never
  in code. A mention is written as `[@Name](ndbrain:user/<account id>)` and
  drawn as a chip with the name the person goes by now, so it survives a
  rename; outside ndBrain it reads as `@Name`. No notification is sent.

## [0.2.0] — 2026-10-23

The editor learns what AFFiNE's does — as Markdown. Every addition here either
changes what is drawn or makes an ordinary edit; the file stays something any
other editor reads the same way.

### Added

- **A bar over a selection** with bold, italic, strikethrough, inline code,
  highlight (`==text==`), link, link to a note, and turning the line into a
  heading, task or quote. New shortcuts: Ctrl/⌘ Shift X, H and K.
- **Callouts**, `> [!warning] Title`, in the form Obsidian and GitHub write.
  `[!type]-` opens folded.
- **Folding** headings and callouts from a triangle in the margin. A fold is
  the view's and never written to the file.
- **A handle beside each block**: drag to move it, or click for a menu to turn
  it into another kind, move it up or down, duplicate or delete it. A list item
  moves with its children. Not shown on touch screens.
- **Embeds**: Mermaid diagrams and KaTeX formulas (`$…$`, `$$…$$`), both loaded
  only when a note uses them; `![[Note]]` as a card with the note's opening;
  other attachments as a download chip; a URL alone in its paragraph as a card
  with the page's title; a preview when hovering a `[[wikilink]]`, and Ctrl/⌘
  click to open it.
- `GET /api/v1/unfurl` for those cards. It fetches public addresses only,
  checked at connection time, on ports 80 and 443, and returns title,
  description and site name — no image, which the content security policy
  would refuse and which would tell the linked site who is reading.

### Changed

- **The signposts are one file.** `vaults/by-name/`, a directory of symlinks,
  is replaced by `vaults/WHOSE-NOTES.txt`, one line per account. The directory
  disappears by itself on the first start of this version; nothing to do, it
  only looks unexpected if you do not know.
- The web build inlines no asset as a `data:` URL any more, so fonts and images
  all come from this origin, as the content security policy requires.

## [0.1.1] — 2026-10-02

Two fixes from the same outage, on the day of the first release. Nothing here
changes what ndBrain does; it changes what it survives.

### Fixed

- **A service that would not start, over a directory nothing reads.** The
  signposts under `vaults/by-name` are cleared and rebuilt on every start, and
  `writeSignposts` promises in its own docstring that a link it cannot write is
  not a reason to fail. That held for the links and not for the two lines that
  clear the directory they live in. On the author's own instance a sidecar had
  written files in there as root, the application cleared them as another user,
  and it went into a restart loop while every note beside it was intact and
  servable. An incomplete signpost directory is now a line in the log.
- **`ops/vault-history.sh` treated the signpost directory as a vault**, giving it
  a git repository that it then committed into as root, which is where those
  root-owned files came from. It also checked `.git` for ownership without
  looking inside it, so every commit it made left new objects behind that the
  application could read but not remove — 1305 of them on the live instance,
  unnoticed for weeks, because reading them works.

### Changed

- Dependencies: the grouped minor and patch updates for `server/` and `web/`,
  the pinned GitHub Actions, and jsdom 30 in the web test environment. Nothing
  here changes behaviour.

## [0.1.0] — 2026-10-02

The first release. ndBrain had been running from `main` for two months before
this; what makes today different is that there is now an image somebody else can
pull and a test suite that runs before it is published.

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
