/**
 * The MCP tool surface.
 *
 * Deliberately general: this is not "the myai integration", it is the endpoint
 * any MCP client can point at — Claude Desktop, Claude Code, an editor plugin,
 * somebody else's agent. That shapes the design in three ways:
 *
 *  - **Tool descriptions are written for a model that has never seen this vault.**
 *    They say when to reach for the tool, not just what it does.
 *  - **Every call is checked twice**: the owner's vault boundary (as everywhere
 *    else) and the key's own path scope. A key can only ever see less than its
 *    owner, never more.
 *  - **Refusals look like absence.** A note outside the key's scope is reported
 *    as not found — telling a scoped agent "that exists but you may not read it"
 *    hands it a map of what it is missing.
 *
 * **A key sees only its owner's own vault, never what others have shared with
 * them.** Every query below passes the owner where the rest of the application
 * passes a view. Someone who shares a folder with a person did not thereby agree
 * to that person's agents reading it, and an agent key is exactly the credential
 * most likely to end up in a config file on some other machine. Widening this
 * later is one line; narrowing it after somebody's notes have been read by an
 * agent they never heard of is not.
 */

import type { App } from '../app.js';
import { withinScope, type ApiKey, type ApiKeyService } from '../auth/keys.js';
import { normalizePrefix, type View } from '../auth/shares.js';
import { NoteNotFoundError } from '../errors.js';
import type { DeletedNotes } from '../notes/deleted.js';
import { normalizeVaultPath } from '../vault/paths.js';

export interface ToolContext {
  app: App;
  keys: ApiKeyService;
  key: ApiKey;
  /**
   * Recently deleted, so `delete_note` can say whether the way back is really
   * there. A delete that implies a 30-day undo the host never set up is the
   * one promise this surface must not make loosely.
   */
  deleted: DeletedNotes;
}

/**
 * A refusal the calling model is meant to read and act on.
 *
 * Separate from the ordinary error path because the two want opposite handling:
 * an unexpected failure is logged and reduced to "internal error" so it cannot
 * leak a path, whereas "this key is read-only" or "that text appears 2 times" is
 * the whole answer. Collapsing the second kind into the first leaves an agent
 * with nothing to correct, and fills the log with entries nobody needs to read.
 */
export class ToolRefusal extends Error {}

/**
 * JSON Schema as MCP clients receive it.
 *
 * Written literally rather than derived from a validation library: the schema is
 * a wire format the client reads, and generating it from Zod meant introspecting
 * internals that change between major versions. What a client sees is now
 * exactly what is written here.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  /**
   * Whether one call can remove content that was there before, the way `rm`
   * or a destructive migration would. Required rather than defaulted so that
   * adding a tool means deciding this, not inheriting whatever the one written
   * above it happened to have.
   */
  destructive: boolean;
  /** Receives arguments that have already been through `checkArguments`. */
  handler: (context: ToolContext, input: Record<string, unknown>) => Promise<string>;
}

function schema(
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Holds a call to the schema the tool publishes.
 *
 * `tools/list` hands every client a schema with a `required` list and
 * `additionalProperties: false`, and nothing used to check that a call obeyed
 * it. The handlers coerced instead — `String(input['replace'] ?? '')` — which
 * turns a wrong argument *name* into a plausible value rather than an error.
 * That is not hypothetical: an agent sent `new_string` (the name the editor
 * tool uses), `replace` was therefore absent, `edit_note` read it as the empty
 * string, deleted the span it had found — frontmatter and all — and reported
 * "Edited". Seventeen notes in one run.
 *
 * Checked against the very object the client was handed, rather than against a
 * second declaration beside it: two descriptions of one contract drift, and the
 * half nobody enforces is the half that lies. The REST layer reached the same
 * conclusion with Zod (`body()` in http/server.ts); this is that rule for the
 * other door.
 *
 * Refusals, not protocol errors: the model is supposed to read them and correct
 * itself, so they name the argument and say what the tool actually takes.
 *
 * Also the point where a rejected call is recorded to the access log. Before
 * this logged, a call an agent got wrong at the schema level — the exact kind
 * of mistake that caused the incident above — left no trace: the log only
 * heard from calls that made it into a handler. The path is logged as `null`
 * rather than read out of `raw`, since at this point it has not been checked
 * against anything and is not safe to treat as a real vault path.
 */
export function checkArguments(
  tool: ToolDefinition,
  raw: unknown,
  context: ToolContext,
): Record<string, unknown> {
  const refuse = (message: string): never => {
    context.keys.log(context.key, tool.name, null, false);
    throw new ToolRefusal(message);
  };

  if (raw === undefined || raw === null) raw = {};

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    refuse(`${tool.name} expects its arguments as an object`);
  }

  const input = raw as Record<string, unknown>;
  const declared = Object.keys(tool.inputSchema.properties);

  for (const name of Object.keys(input)) {
    if (declared.includes(name)) continue;
    refuse(
      `${tool.name} has no argument "${name}" — it takes ${declared.join(', ')}. ` +
        'Nothing was changed.',
    );
  }

  for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
    const value = input[name];

    // A null is an absent argument, not a value of the wrong type: clients
    // serialise "I have nothing for this" both ways.
    if (value === undefined || value === null) {
      if (tool.inputSchema.required.includes(name)) {
        refuse(`${tool.name} needs "${name}". Nothing was changed.`);
      }
      continue;
    }

    if (typeof value !== property.type) {
      refuse(
        `${tool.name} wants "${name}" as a ${property.type}, not a ${typeof value}. ` +
          'Nothing was changed.',
      );
    }
  }

  return input;
}

/** Denials are indistinguishable from a missing note — see the file header. */
function assertInScope(context: ToolContext, tool: string, rawPath: string): string {
  const notePath = normalizeVaultPath(rawPath);

  if (!withinScope(context.key, notePath)) {
    context.keys.log(context.key, tool, notePath, false);
    throw new NoteNotFoundError('note does not exist');
  }

  return notePath;
}

function assertWritable(context: ToolContext, tool: string, notePath: string | null): void {
  if (!context.key.canWrite) {
    context.keys.log(context.key, tool, notePath, false);
    throw new ToolRefusal('this key is read-only; ask the user for a key that may write');
  }
}

/** Drops results outside the key's scope, without revealing that they existed. */
function inScope<T extends { path: string }>(context: ToolContext, rows: T[]): T[] {
  return rows.filter((row) => withinScope(context.key, row.path));
}

/**
 * The key's scope in the shape every query already takes.
 *
 * A key's scope is exactly one region of one vault, which is what a `View` is,
 * so handing a query this puts the scope into the SQL instead of dropping rows
 * after they come back. That is correctness, not tidiness: a `LIMIT` applied
 * before the scope cuts the wrong rows. `vault_map` asked for the owner's whole
 * vault `ORDER BY n.path LIMIT 5000` and filtered afterwards, so a key scoped to
 * a folder that sorts late answered "No notes." on any vault past five
 * thousand — and by the rule in the file header it could not tell that from a
 * folder that is empty, which is the one thing a map must never be wrong about
 * silently. `search_notes` had the same shape, softened by asking for three
 * times the limit, which is a guess that runs out rather than a rule. A cap
 * belongs after what the caller may see, never before it.
 *
 * Still one rule and not a second copy of it: `scopeSql` in `queries.ts` builds
 * this from `regionSql`, the SQL twin of the `inScope` that `withinScope`
 * itself calls.
 */
function keyView(key: ApiKey): View {
  return [{ owner: key.owner, prefix: key.scope, exact: false, canWrite: key.canWrite }];
}

/**
 * That view narrowed to one folder, for the tools that take a `folder`.
 *
 * The narrower of the two prefixes, and an empty view — which `scopeSql` turns
 * into `1 = 0` — when neither contains the other. Deliberate rather than
 * incidental: asking for a folder outside the scope has to answer exactly like
 * asking for one that is empty.
 *
 * `normalizePrefix` rather than a trailing slash appended here. The slash is
 * what stops `Homelab` from also covering `Homelab2`, and it is the rule both
 * shares and key scopes are normalised with; a folder that cannot be a path at
 * all is refused by it, which is an answer the calling model can correct.
 */
function viewUnder(key: ApiKey, folder: string): View {
  if (folder === '') return keyView(key);

  const prefix = normalizePrefix(folder);
  if (prefix === '' || key.scope.startsWith(prefix)) return keyView(key);
  if (prefix.startsWith(key.scope)) {
    return [{ owner: key.owner, prefix, exact: false, canWrite: key.canWrite }];
  }
  return [];
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search_notes',
    title: 'Search notes',
    description:
      'Full-text search across the notes. Use this first when you need information that might be ' +
      'written down but you do not know which note holds it. Returns matching notes with a short ' +
      'excerpt each. Optional filters: a tag, a folder, and a number of days to look back.',
    readOnly: true,
    destructive: false,
    inputSchema: schema(
      {
        query: { type: 'string', description: 'Words to search for. May be empty when using only filters.' },
        tag: { type: 'string', description: 'Only notes carrying this tag.' },
        folder: { type: 'string', description: 'Only notes below this folder.' },
        days: { type: 'number', description: 'Only notes modified within this many days.' },
        limit: { type: 'number', description: 'Maximum results (default 20).' },
      },
      ['query'],
    ),
    handler: async (context, input) => {
      const options: Parameters<typeof context.app.queries.search>[2] = {
        limit: clampLimit(input['limit'], 20),
      };
      if (typeof input['tag'] === 'string') options.tag = input['tag'];
      if (typeof input['folder'] === 'string') options.dir = input['folder'];
      if (typeof input['days'] === 'number' && input['days'] > 0) {
        options.sinceMs = Date.now() - input['days'] * 86_400_000;
      }
      // The scope travels with the query, so the limit means what it says. This
      // used to ask for three times as many rows and drop the out-of-scope ones
      // afterwards — see `keyView` for why that is a guess and not a rule.
      const hits = context.app.queries.search(
        keyView(context.key),
        input['query'] as string,
        options,
      );

      context.keys.log(context.key, 'search_notes', null, true);

      if (hits.length === 0) return 'No matching notes.';
      return hits
        .map((hit) => `## ${hit.title}\n${hit.path}\n${hit.snippet || '(no excerpt)'}`)
        .join('\n\n');
    },
  },

  {
    name: 'get_note',
    title: 'Read a note',
    description:
      'Read one note in full, by its path (for example "Homelab/Proxmox.md"). Use search_notes ' +
      'first if you do not already know the exact path.',
    readOnly: true,
    destructive: false,
    inputSchema: schema(
      { path: { type: 'string', description: 'Vault-relative path, ending in .md' } },
      ['path'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'get_note', input['path'] as string);
      const note = await context.app.notes.getNote(context.key.owner, notePath);
      context.keys.log(context.key, 'get_note', notePath, true);
      return note.content;
    },
  },

  {
    name: 'list_notes',
    title: 'List notes',
    description:
      'List note paths, optionally under one folder. Use this to get an overview of how the vault ' +
      'is organised before reading or writing.',
    readOnly: true,
    destructive: false,
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only list below this folder.' },
        limit: { type: 'number', description: 'Maximum paths (default 200).' },
      },
      [],
    ),
    handler: async (context, input) => {
      const folder = typeof input['folder'] === 'string' ? input['folder'] : '';
      const prefix = folder === '' ? '' : `${folder.replace(/\/+$/, '')}/`;

      const notes = inScope(context, await context.app.notes.listNotes(context.key.owner))
        .filter((entry) => entry.path.startsWith(prefix))
        .slice(0, clampLimit(input['limit'], 200))
        .map((entry) => entry.path);

      context.keys.log(context.key, 'list_notes', folder || null, true);
      return notes.length === 0 ? 'No notes.' : notes.join('\n');
    },
  },

  {
    name: 'vault_map',
    title: 'Map the vault',
    description:
      'One line per note: path, title, tags and frontmatter properties, without any note text. ' +
      'Ask for this first. It is the cheap way to see what exists and how it is described, so a ' +
      'following get_note can be aimed rather than guessed — searching and pulling whole notes ' +
      'back to find out what is in the vault costs far more and still misses whatever you did ' +
      'not think to search for.',
    readOnly: true,
    destructive: false,
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only map notes below this folder.' },
        limit: { type: 'number', description: 'Maximum notes (default 500).' },
      },
      [],
    ),
    handler: async (context, input) => {
      const folder = typeof input['folder'] === 'string' ? input['folder'] : '';

      // The scope and the folder both reach the query as one region, so the
      // limit cuts the notes this key asked for and not the ones that happened
      // to sort first in somebody's whole vault. See `keyView`.
      const rows = context.app.queries.vaultMap(
        viewUnder(context.key, folder),
        clampLimit(input['limit'], 500),
      );

      context.keys.log(context.key, 'vault_map', folder || null, true);
      if (rows.length === 0) return 'No notes.';

      const lines = rows.map((row) => {
        const parts = [row.path];
        if (row.tags.length > 0) parts.push(`tags: ${row.tags.join(', ')}`);
        for (const [key, values] of Object.entries(row.props)) {
          parts.push(`${key}: ${values.join(', ')}`);
        }
        return parts.join('  |  ');
      });

      return lines.join('\n');
    },
  },

  {
    name: 'get_links',
    title: 'Show a note\'s connections',
    description:
      'Show which notes link to this one and which notes it links to. Use it to find related ' +
      'context before answering, or to check whether a note is isolated.',
    readOnly: true,
    destructive: false,
    inputSchema: schema(
      { path: { type: 'string', description: 'Vault-relative path, ending in .md' } },
      ['path'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'get_links', input['path'] as string);

      const backlinks = context.app.queries
        .backlinks(context.key.owner, context.key.owner, notePath)
        .filter((link) => withinScope(context.key, link.source));
      // Both directions obey the same rule, and the outgoing side obeys it by
      // *unresolving* rather than dropping. The indexer resolves links against
      // the whole vault, not against the key's scope, so a resolved target
      // outside it would be a path the key may not read. Reporting it as "does
      // not exist" is the file header's rule applied to a link: refusal looks
      // like absence.
      //
      // Dropping the line instead would leak the same fact one step further
      // back. The key can read the note, so it knows which `[[…]]` are written
      // in it; a link present in the text but missing from this list could only
      // mean "exists, not yours". A writing key could then ask that about any
      // name it likes by putting the name into a note of its own — a free
      // existence oracle over the whole vault. The raw link text is safe to
      // echo: it stands in a note the key is already reading.
      const outgoing = context.app.queries
        .outgoingLinks(context.key.owner, context.key.owner, notePath)
        .map((link) =>
          link.targetPath !== null && !withinScope(context.key, link.targetPath)
            ? { ...link, targetPath: null }
            : link,
        );

      context.keys.log(context.key, 'get_links', notePath, true);

      const lines = [
        `Linked from (${backlinks.length}):`,
        ...backlinks.map((link) => `  ${link.source}`),
        `Links to:`,
        ...outgoing.map((link) =>
          link.targetPath === null
            ? `  ${link.targetRaw} — does not exist`
            : `  ${link.targetPath}`,
        ),
      ];
      return lines.join('\n');
    },
  },

  {
    name: 'list_tasks',
    title: 'List open tasks',
    description:
      'Every unfinished "- [ ]" checkbox written in the notes, with the note it stands in and its ' +
      'line number. Use it to answer "what is still open" without reading notes one by one, and to ' +
      'find the note holding a task before editing it. Optionally limited to one folder. Finished ' +
      'items are left out unless you ask for them.',
    readOnly: true,
    destructive: false,
    inputSchema: schema(
      {
        folder: { type: 'string', description: 'Only tasks in notes below this folder.' },
        include_done: { type: 'boolean', description: 'Include finished items too (default false).' },
        limit: { type: 'number', description: 'Maximum tasks (default 100).' },
      },
      [],
    ),
    handler: async (context, input) => {
      const folder = typeof input['folder'] === 'string' ? input['folder'] : '';
      // The folder narrows the region rather than filtering the rows the query
      // came back with, for the same reason `vault_map` does — otherwise the
      // limit is spent on tasks that are then thrown away. See `keyView`.
      const view = viewUnder(context.key, folder);

      const filter: Parameters<typeof context.app.queries.tasks>[1] = {
        limit: clampLimit(input['limit'], 100),
      };
      if (input['include_done'] === true) filter.includeDone = true;

      const tasks = context.app.queries.tasks(view, filter);
      const total = context.app.queries.taskCount(view, filter);

      context.keys.log(context.key, 'list_tasks', folder || null, true);
      if (tasks.length === 0) return 'No open tasks.';

      const lines = tasks.map(
        (task) => `${task.done ? '[x]' : '[ ]'} ${task.text}  —  ${task.path}:${task.line}`,
      );
      // A capped list that does not say it was capped reads as "that was all of
      // them", and the work then looks finished when it is not. The task view
      // reports its own total for exactly this reason.
      if (total > tasks.length) {
        lines.push(`… and ${total - tasks.length} more; narrow it with a folder or raise the limit.`);
      }
      return lines.join('\n');
    },
  },

  /**
   * The tidying half of the librarian, for an agent rather than for the eye.
   *
   * **Which findings, and why these three.** The tidy view knows five. Three of
   * them name a defect an agent can actually repair with the tools it already
   * has: a dead link is fixed by correcting the `[[…]]` or writing the note it
   * names, an orphan by linking it from wherever it belongs, an untagged note
   * by adding the tag the rest of the vault uses. The other two are not work,
   * they are judgement. "Untouched for 90 days" is a number a person reads
   * against what the note is for — last spring's journal is not neglected — and
   * an agent that goes off "refreshing" old notes is doing the one thing it
   * must not do unasked. A conflict copy asks which of two versions of
   * somebody's own writing survives; that is a decision to put in front of the
   * person, not a chore to hand to a key. Offering either would have been a
   * number in a list, and a number an agent feels obliged to act on is worse
   * than no number.
   *
   * `untaggedFindings` rather than `untagged`, so a vault that has never used a
   * tag is not reported as sixty defects — the same rule the overview and the
   * tidy table share, from the same function.
   *
   * **Scope.** Every list is asked for as a `View`, never filtered afterwards:
   * a cap applied before the scope cuts the wrong rows (see `keyView`). The
   * heavy lifting for dead links is in `Queries.deadLinks` — read its comment
   * for what "broken" means to a key that holds one folder, and for why that
   * answer is what keeps this tool from being an existence oracle over the rest
   * of the vault.
   */
  {
    name: 'list_findings',
    title: 'List what needs tidying',
    description:
      'What is untidy in the notes: links that point nowhere, notes nothing links to, and notes ' +
      'carrying no tag. Use it before tidying up, or when asked to clean something up — it names ' +
      'the note to open for each finding, so a following edit_note or create_note can be aimed ' +
      'rather than guessed. Optionally limited to one folder or to one kind of finding.',
    readOnly: true,
    destructive: false,
    inputSchema: schema(
      {
        kind: {
          type: 'string',
          description: 'One of dead_links, orphans, untagged. Omit for all three.',
        },
        folder: { type: 'string', description: 'Only findings in notes below this folder.' },
        limit: { type: 'number', description: 'Maximum entries per kind (default 50).' },
      },
      [],
    ),
    handler: async (context, input) => {
      // `checkArguments` holds the call to the published schema, but the schema
      // only says "string" — the set of names is this tool's own contract, so
      // it is refused here, by name, the way a wrong argument name is.
      const kind = typeof input['kind'] === 'string' ? input['kind'] : '';
      if (kind !== '' && !FINDING_KINDS.includes(kind)) {
        context.keys.log(context.key, 'list_findings', null, false);
        throw new ToolRefusal(
          `list_findings has no finding called "${kind}" — it knows ${FINDING_KINDS.join(', ')}. ` +
            'Omit it to get all three.',
        );
      }

      const folder = typeof input['folder'] === 'string' ? input['folder'] : '';
      const view = viewUnder(context.key, folder);
      const limit = clampLimit(input['limit'], 50);
      const wanted = (name: string): boolean => kind === '' || kind === name;

      const sections: string[][] = [];
      let found = 0;

      if (wanted('dead_links')) {
        const rows = context.app.queries.deadLinks(view);
        found += rows.length;
        sections.push(
          findingSection(
            'Links that point nowhere',
            rows.length,
            limit,
            rows.slice(0, limit).map((link) => `  ${link.source} → [[${link.targetRaw}]]`),
          ),
        );
      }

      if (wanted('orphans')) {
        const rows = context.app.queries.orphans(view);
        found += rows.length;
        sections.push(
          findingSection(
            'Notes nothing links to',
            rows.length,
            limit,
            rows.slice(0, limit).map((note) => `  ${note.path}`),
          ),
        );
      }

      if (wanted('untagged')) {
        const rows = context.app.queries.untaggedFindings(view);
        found += rows.length;
        sections.push(
          findingSection(
            'Notes without a tag',
            rows.length,
            limit,
            rows.slice(0, limit).map((note) => `  ${note.path}`),
          ),
        );
      }

      context.keys.log(context.key, 'list_findings', folder || null, true);

      if (found === 0) return 'Nothing to tidy.';
      return sections.map((lines) => lines.join('\n')).join('\n\n');
    },
  },

  {
    name: 'create_note',
    title: 'Create a note',
    description:
      'Create a new note. Fails if one already exists at that path — use append_note or edit_note ' +
      'to change an existing note rather than overwriting it. Link to other notes with [[Wikilinks]].',
    readOnly: false,
    // Refuses when the target already exists, so it cannot overwrite content
    // that was there before — the case destructiveHint is meant to flag.
    destructive: false,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Vault-relative path, ending in .md' },
        content: { type: 'string', description: 'Full Markdown content of the new note.' },
      },
      ['path', 'content'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'create_note', input['path'] as string);
      assertWritable(context, 'create_note', notePath);

      const note = await context.app.createNote(
        context.key.owner,
        notePath,
        input['content'] as string,
        context.key.name,
      );
      context.keys.log(context.key, 'create_note', note.path, true);
      return `Created ${note.path}`;
    },
  },

  {
    name: 'append_note',
    title: 'Append to a note',
    description:
      'Add text to the end of an existing note. This is the safe way to add something without ' +
      'risking the rest of the note — prefer it over rewriting. Safe as well while somebody is ' +
      'editing the same note: the text is added to whatever the note holds at the moment it ' +
      'lands, so nothing anybody wrote is overwritten and there is nothing to reconcile after.',
    readOnly: false,
    // Purely additive: it only ever grows the note, so nothing existing can
    // be lost through it.
    destructive: false,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Vault-relative path, ending in .md' },
        content: { type: 'string', description: 'Markdown to append.' },
      },
      ['path', 'content'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'append_note', input['path'] as string);
      assertWritable(context, 'append_note', notePath);

      // The same call `POST /api/v1/append/*` makes, for the same reason: read
      // and write happen inside one hold of the note's lock, so there is no
      // moment between them for anybody else's save to land in. See
      // `NoteService.appendNote`.
      //
      // This used to be a read-modify-write here — `getNote`, `appended`,
      // `updateNote` with `baseMtimeMs` — and it carried the base version so
      // that a save landing in the gap was kept as a conflict copy rather than
      // overwritten. The gap is gone, so the copy is too: a save now lands
      // before the append or after it, and either way both texts are in the one
      // note. Handing the person two files to reconcile was the consolation
      // prize for a race, never the goal.
      const result = await context.app.appendNote(
        context.key.owner,
        notePath,
        input['content'] as string,
        context.key.name,
      );
      context.keys.log(context.key, 'append_note', notePath, true);
      return `Appended to ${result.note.path}`;
    },
  },

  {
    name: 'edit_note',
    title: 'Edit part of a note',
    description:
      'Replace an exact piece of text in a note. The text to replace must appear exactly once — ' +
      'if it appears zero times or several times the edit is refused rather than guessing.',
    readOnly: false,
    // Destructive by accident rather than by purpose, unlike `delete_note`:
    // `replace` is unconstrained, so a single call can remove the whole matched
    // span — this is what deleted a note's frontmatter three times over before
    // checkArguments existed to catch a misnamed argument.
    destructive: true,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Vault-relative path, ending in .md' },
        find: { type: 'string', description: 'Exact text to replace. Must occur exactly once.' },
        replace: { type: 'string', description: 'Replacement text.' },
      },
      ['path', 'find', 'replace'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'edit_note', input['path'] as string);
      assertWritable(context, 'edit_note', notePath);

      const find = input['find'] as string;
      if (find === '') throw new ToolRefusal('nothing to find');

      const note = await context.app.notes.getNote(context.key.owner, notePath);
      const occurrences = note.content.split(find).length - 1;

      // Refusing an ambiguous edit is the whole point: a "replace the first
      // match" fallback silently edits the wrong paragraph.
      if (occurrences === 0) throw new ToolRefusal('that text does not appear in the note');
      if (occurrences > 1) {
        throw new ToolRefusal(
          `that text appears ${occurrences} times; include more context to make it unique`,
        );
      }

      // Spliced by offset rather than with `String.replace`. That method reads
      // `$&`, '$`', `$'` and `$$` in the replacement as patterns even when the
      // thing being searched for is a plain string — so replacing a line with
      // one that mentions `$'` (bash quoting, and ordinary in a homelab note)
      // would paste the rest of the file into the middle of the note. Nothing
      // outside the found span may change, and the only way to mean that is to
      // keep the two ends of the note untouched.
      const at = note.content.indexOf(find);
      const edited =
        note.content.slice(0, at) +
        (input['replace'] as string) +
        note.content.slice(at + find.length);

      const result = await context.app.updateNote(
        context.key.owner,
        notePath,
        edited,
        context.key.name,
        // The text this edit was reasoned about, not the moment it was read at:
        // the note may have been restored from a backup in the meantime, which
        // leaves changed text behind an older stamp. See `#preserveDisplaced`.
        { baseHash: note.hash },
      );
      context.keys.log(context.key, 'edit_note', notePath, true);
      return result.conflictCopy === undefined
        ? `Edited ${notePath}`
        : `Edited ${notePath}. Somebody else had changed the note since it was read; ` +
          `their version was kept as ${result.conflictCopy}.`;
    },
  },

  {
    name: 'delete_note',
    title: 'Delete a note',
    description:
      'Delete one note. Use it to clear away something that should not have been written — a note ' +
      'that merely sits in the wrong place belongs in rename_note instead, which keeps its links ' +
      'and its history. The note lands in "Recently deleted", where its owner can bring it back ' +
      'for 30 days; the answer says whether a saved version to bring back actually exists.',
    readOnly: false,
    // The one tool whose whole purpose is to remove content.
    destructive: true,
    inputSchema: schema(
      { path: { type: 'string', description: 'Vault-relative path, ending in .md' } },
      ['path'],
    ),
    /**
     * Whose notes an agent may delete: any note inside its scope, including
     * ones it never wrote.
     *
     * The alternative — a key may delete only what it created — was considered
     * and `edits` cannot carry it. The column that would answer it is free
     * text, key names are not unique (two keys may both be called `tidy`), and
     * decisively: a note that arrived as a file has no `create` row at all. The
     * watcher and the startup sync index without writing to `edits`, because
     * that log records what was changed *through* ndBrain. An authorship rule
     * would therefore refuse exactly the notes an agent is asked to tidy — the
     * imported vault, which is most of it — and permit exactly the ones nobody
     * worries about. It would not even be a boundary: an agent that wanted a
     * note gone could create one, and delete that, to prove it may.
     *
     * What bounds the damage is what bounds it for a person: the scope, the
     * write bit, and the 30-day way back. Which is why this reports whether
     * that way back is really there rather than assuming it.
     */
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'delete_note', input['path'] as string);
      assertWritable(context, 'delete_note', notePath);

      // Asked before the delete, the way the browser asks before its
      // confirmation: afterwards the answer is the same and the choice is gone.
      // The owner is both sides of it — a key acts as its owner and never as
      // somebody the vault was shared with.
      const preview = await context.deleted.preview(context.key.owner, context.key.owner, [notePath]);

      await context.app.deleteNote(context.key.owner, notePath, context.key.name);
      context.keys.log(context.key, 'delete_note', notePath, true);

      return preview.restorable > 0
        ? `Deleted ${notePath}. Its owner can bring it back from "Recently deleted" for 30 days.`
        : `Deleted ${notePath}. No saved version of it exists, so it cannot be brought back.`;
    },
  },

  {
    name: 'rename_note',
    title: 'Rename or move a note',
    description:
      'Rename a note, or move it to another folder, rewriting every [[Wikilink]] that pointed at ' +
      'it so nothing breaks. Always prefer this over creating a copy and deleting the original: ' +
      'that loses the links pointing at it and its place in the history. Both paths must lie ' +
      'inside what this key may reach.',
    readOnly: false,
    // The note survives the call, but the call still removes text that was
    // there: every `[[…]]` naming the old path is replaced, in notes the caller
    // never named. And unlike a delete there is no "recently renamed" to walk
    // it back from — which is exactly the case a client should be able to
    // prompt about.
    destructive: true,
    inputSchema: schema(
      {
        from: { type: 'string', description: 'Current vault-relative path, ending in .md' },
        to: { type: 'string', description: 'New vault-relative path, ending in .md' },
      },
      ['from', 'to'],
    ),
    /**
     * A scoped key's rename writes outside its scope. Decided, not overlooked.
     *
     * `App.renameNote` rewrites every `[[wikilink]]` that pointed at the note
     * across the whole of the owner's vault — read its comment for why it has
     * to. So a key scoped to `Agent/` renaming a note there can change a line
     * in `Privat/`, and that is allowed here.
     *
     * The argument for it. The write is not arbitrary: the only text this can
     * produce is a wikilink naming a path the key was already permitted to
     * name, in a note that already pointed at a note inside the key's scope. A
     * key cannot reach a note that never mentioned its folder, cannot choose
     * what is written there, and cannot read the result. Against that, every
     * alternative is worse. Rewriting only inside the scope leaves the owner
     * with a dead link in a note nobody touched — silent damage found weeks
     * later, which is the very thing the rewrite exists to prevent. Refusing
     * the rename when an out-of-scope note links to it turns the tool into the
     * existence oracle `get_links` was carefully built not to be: the refusal
     * would itself announce that something invisible points here. Allowing
     * renames only for keys with no scope withholds the tool from exactly the
     * agent it was built for.
     *
     * What is *not* allowed is telling the key what it touched. `view` bounds
     * the report and never the rewrite, and the view passed is the key's scope
     * rather than its owner's vault — the REST route passes the caller's share
     * view for the same reason, and a grantee was once handed
     * `Privat/Heimlich.md` in this field for free.
     */
    handler: async (context, input) => {
      const source = assertInScope(context, 'rename_note', input['from'] as string);
      // Both ends. A rename guarded only at the source is the way to walk a
      // note out of the scope and then read it from outside — the same reason
      // the REST route checks the destination.
      const target = assertInScope(context, 'rename_note', input['to'] as string);
      assertWritable(context, 'rename_note', source);

      // No `authorizeSource`/`authorizeTarget` hooks, unlike the REST route.
      // Those re-check a *share* inside the note's lock because a share can be
      // withdrawn mid-call, by its owner or by the binding check running in
      // that same lock. A key's scope and write bit are set when it is created
      // and never change: there is nothing for a second look to find.
      const result = await context.app.renameNote(context.key.owner, source, target, {
        view: keyView(context.key),
        actor: context.key.name,
      });

      context.keys.log(context.key, 'rename_note', target, true);

      const updated = result.updatedLinks;
      if (updated.length === 0) return `Renamed ${source} to ${target}.`;
      // Counted as the length of what is named, never separately: a count of
      // two beside one path would say the second exists. See `App.renameNote`.
      return (
        `Renamed ${source} to ${target}. Links updated in ${updated.length} ` +
        `${updated.length === 1 ? 'note' : 'notes'}:\n` +
        updated.map((notePath) => `  ${notePath}`).join('\n')
      );
    },
  },
];

/** What `list_findings` offers, and the list its refusal quotes back. */
const FINDING_KINDS = ['dead_links', 'orphans', 'untagged'];

/**
 * One block of `list_findings`, honest about what it left out.
 *
 * A capped list that does not say it was capped reads as "that was all of
 * them", and the tidying then looks finished when it is not — the same reason
 * `list_tasks` reports its own total and the tidy view carries `truncated`.
 * The count is the real one, so a section header stands for the whole finding
 * even when only part of it is printed.
 */
function findingSection(title: string, total: number, limit: number, lines: string[]): string[] {
  if (total === 0) return [`${title}: none.`];

  const out = [`${title} (${total}):`, ...lines];
  if (total > lines.length) {
    out.push(`  … and ${total - lines.length} more; narrow it with a folder or raise the limit.`);
  }
  return out;
}

function clampLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200, Math.trunc(parsed));
}
