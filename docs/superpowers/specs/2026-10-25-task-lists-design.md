# Task lists

Status: design agreed 2026-10-25, phase 1 (server) in progress on `feat/task-lists`.

## Why

ndBrain collects every `- [ ]` written in a note, and that is a good to-do list. It is not task
planning: a checkbox has no status beyond done, no assignee, no due date anybody can sort by, no
place on a board. Writing those into the line (`📅 2026-10-30 ⏫`) or into a note's frontmatter
was considered and rejected — board order, per-field changes by two people at once and hundreds
of task notes flooding the tree, the search and *Tidy up* all fit Markdown badly.

So task planning is its own module, with its own data model and its own views, modelled on the
task planning of ClickUp (lists, statuses, assignees, dates, subtasks, board). Not on ClickUp as a
whole; see *Non-goals*.

## Decision this has to live with

**The files are the truth.** A task list is a file in the vault, the index stays a cache, and
migration stays copying a folder.

Two places to put that file were rejected on the way:

- **A hidden `.tasks/` directory.** `normalizeVaultPath` refuses every segment that begins with a
  dot, and that rule is load-bearing: it is what keeps `.git` — and with it the history timer
  running git as root — out of reach of every write route. Loosening it for one name would put a
  security boundary behind a string comparison. And a directory at the vault root would not be
  covered by a folder share: sharing `Kunden/Acme/` must share Acme's tasks.
- **SQLite as the truth.** Faster to build, but shares, spaces, agent key scopes and "a refusal
  looks like an absence" all hang off paths. A database module would need a second permission
  model beside them, in a product strangers host for other people.

## The file

One file per list, anywhere in the vault, named `<List name>.tasks.json`. The list's name is the
file name, for the reason a note's title is: it is visible without opening anything, and a
rename is a rename.

```json
{
  "ndbrain": "tasklist/1",
  "statuses": [
    { "id": "todo", "name": "To do", "done": false },
    { "id": "doing", "name": "In progress", "done": false },
    { "id": "done", "name": "Done", "done": true }
  ],
  "tasks": [
    {
      "id": "k7Qm2xR9",
      "title": "Send the offer",
      "status": "todo",
      "priority": "high",
      "assignees": ["u_3f9c…"],
      "start": null,
      "due": "2026-10-30",
      "tags": ["kunde"],
      "description": "Markdown.",
      "parent": null,
      "order": "a0",
      "created": "2026-10-25T09:12:00.000Z",
      "updated": "2026-10-25T09:12:00.000Z"
    }
  ]
}
```

- **`ndbrain`** names the format and its version, so a later server can migrate a file it
  recognises and refuse one it does not.
- **Statuses belong to the list.** No status name appears in the code, for the same reason no
  folder name does. A status marked `done` is what "finished" means for filtering.
- **Ids are random**, eight characters from a URL-safe alphabet. A counter would say how many
  tasks a list has had.
- **`assignees` are account ids**, the same ids an `@` mention writes. Not checked against the
  account list: whether an id belongs to somebody is not the writer's to learn.
- **`order`** is a fractional index (a string that sorts between its neighbours), so moving a
  card on the board rewrites one task rather than renumbering a column.
- **`parent`** makes a task a subtask. One level, as in ClickUp's default; deeper nesting is not
  refused by the format, only not offered.
- **Unknown keys survive.** On the list and on every task. A file written by a newer server, or
  by hand, must not lose fields because an older server rewrote it. The validated fields are
  checked strictly; everything else is carried through untouched.
- **Written for diffs.** Two-space indent, a fixed key order, the `tasks` array in creation
  order, a trailing newline. The history sidecar commits the vault every two minutes, and a
  change to one task should be a change to a few lines.
- **No activity log in the file.** It would grow without bound. History of who changed what is
  for a later phase, in the `edits` table where the note history already lives.

## One write path

`tasklists/service.ts` is the only code that changes a list file, as `notes/service.ts` is for
notes. Every change is a read-modify-write under a per-file lock keyed by `owner:path`:

- **Changes are per field.** A `PATCH` names the fields it sets; the rest of the task is read
  from the file inside the lock. Two people changing the status and the due date of one task
  both land. The same field changed twice is last-writer-wins, which for a status or a date is
  what anybody would expect. No conflict copies.
- **A file that does not parse is never written over.** Somebody edited it by hand and broke
  it; the read answers `tasklist_invalid` with where it failed, and every write is refused until
  the file is fixed. Overwriting it would throw away what the person was in the middle of.
- **The generic file routes take the same lock.** An upload or a delete through
  `/api/v1/files/*` that names a `.tasks.json` waits for a list write in progress, so the two
  cannot interleave.
- Writes go through `Vault.writeFileBytes`: temporary file, flush, rename.

## Permissions

Every route resolves its owner and path through `target()` and re-checks inside the lock, as the
note and file routes do. Nothing new is needed for shares:

- a vault, folder or space share covers the list files below it, read or write as granted;
- a refusal is the 404 a missing list gets, byte for byte;
- a note share cannot name a list (`a note share names a note`). Sharing one list on its own is
  a later extension of the share model, not part of this.

## API

| Route | Need | What |
|---|---|---|
| `GET /api/v1/tasklists/*` | read | The list. |
| `POST /api/v1/tasklists/*` | write | Creates a list with the default statuses; 409 if one exists. |
| `POST /api/v1/tasklist-items/*` | write | Adds a task; answers it with its new id. |
| `PATCH /api/v1/tasklist-items/*` | write | `{ id, set: { …fields } }` |
| `DELETE /api/v1/tasklist-items/*?id=` | write | Removes a task and its subtasks. |

`owner` rides in the query or the body, as everywhere. `/api/v1/tasks` is not reused: it is the
checkbox list, and both stay.

Finding the lists a caller can see needs no route of its own in phase 1: they are files, and
`/api/v1/files` already lists files through the caller's shares.

## Phases

1. **Server:** format, service, routes, permission and concurrency tests. *(this branch)*
2. **List view:** filter, group, sort, edit in place, a task's detail as a side panel.
3. **Board:** columns are statuses, drag and drop rewrites `order` and `status`.
4. **Calendar:** due dates in the journal calendar.
5. **Index and MCP:** an index table over all lists for questions across them ("mine, due this
   week"), kept by the watcher like the note index, and the MCP tools on top of it.
6. Optional, on demand: dependencies, a timeline, recurring tasks, custom fields, embedding a
   list in a note.

The index is deliberately not in phase 1. Reading one list reads one file, which is always
fresh; the index only earns its keep once something asks across files.

## Non-goals

Automations, time tracking, notifications, live collaboration on a list, docs and whiteboards
inside the module. Each is a project of its own, and v1 of this tool died of exactly that kind of
surface.
