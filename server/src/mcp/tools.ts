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
import { NoteNotFoundError } from '../errors.js';
import { normalizeVaultPath } from '../vault/paths.js';

export interface ToolContext {
  app: App;
  keys: ApiKeyService;
  key: ApiKey;
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
  handler: (context: ToolContext, input: Record<string, unknown>) => Promise<string>;
}

function schema(
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
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

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search_notes',
    title: 'Search notes',
    description:
      'Full-text search across the notes. Use this first when you need information that might be ' +
      'written down but you do not know which note holds it. Returns matching notes with a short ' +
      'excerpt each. Optional filters: a tag, a folder, and a number of days to look back.',
    readOnly: true,
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
      // Ask for extra rows: scope filtering happens after the query, so a scoped
      // key would otherwise see fewer results than it asked for.
      options.limit = Math.min(200, (options.limit ?? 20) * 3);

      const hits = inScope(context, context.app.queries.search(context.key.owner, String(input['query'] ?? ''), options))
        .slice(0, clampLimit(input['limit'], 20));

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
    inputSchema: schema(
      { path: { type: 'string', description: 'Vault-relative path, ending in .md' } },
      ['path'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'get_note', String(input['path'] ?? ''));
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
    name: 'get_links',
    title: 'Show a note\'s connections',
    description:
      'Show which notes link to this one and which notes it links to. Use it to find related ' +
      'context before answering, or to check whether a note is isolated.',
    readOnly: true,
    inputSchema: schema(
      { path: { type: 'string', description: 'Vault-relative path, ending in .md' } },
      ['path'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'get_links', String(input['path'] ?? ''));

      const backlinks = context.app.queries
        .backlinks(context.key.owner, context.key.owner, notePath)
        .filter((link) => withinScope(context.key, link.source));
      const outgoing = context.app.queries.outgoingLinks(
        context.key.owner,
        context.key.owner,
        notePath,
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
    name: 'create_note',
    title: 'Create a note',
    description:
      'Create a new note. Fails if one already exists at that path — use append_note or edit_note ' +
      'to change an existing note rather than overwriting it. Link to other notes with [[Wikilinks]].',
    readOnly: false,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Vault-relative path, ending in .md' },
        content: { type: 'string', description: 'Full Markdown content of the new note.' },
      },
      ['path', 'content'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'create_note', String(input['path'] ?? ''));
      assertWritable(context, 'create_note', notePath);

      const note = await context.app.createNote(
        context.key.owner,
        notePath,
        String(input['content'] ?? ''),
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
      'risking the rest of the note — prefer it over rewriting.',
    readOnly: false,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Vault-relative path, ending in .md' },
        content: { type: 'string', description: 'Markdown to append.' },
      },
      ['path', 'content'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'append_note', String(input['path'] ?? ''));
      assertWritable(context, 'append_note', notePath);

      const note = await context.app.notes.getNote(context.key.owner, notePath);
      const addition = String(input['content'] ?? '');
      // Guarantee a blank line between what was there and what is added, without
      // adding one to a note that already ends in one.
      const separator = note.content.endsWith('\n\n') ? '' : note.content.endsWith('\n') ? '\n' : '\n\n';

      await context.app.updateNote(
        context.key.owner,
        notePath,
        note.content + separator + addition,
        context.key.name,
      );
      context.keys.log(context.key, 'append_note', notePath, true);
      return `Appended to ${notePath}`;
    },
  },

  {
    name: 'edit_note',
    title: 'Edit part of a note',
    description:
      'Replace an exact piece of text in a note. The text to replace must appear exactly once — ' +
      'if it appears zero times or several times the edit is refused rather than guessing.',
    readOnly: false,
    inputSchema: schema(
      {
        path: { type: 'string', description: 'Vault-relative path, ending in .md' },
        find: { type: 'string', description: 'Exact text to replace. Must occur exactly once.' },
        replace: { type: 'string', description: 'Replacement text.' },
      },
      ['path', 'find', 'replace'],
    ),
    handler: async (context, input) => {
      const notePath = assertInScope(context, 'edit_note', String(input['path'] ?? ''));
      assertWritable(context, 'edit_note', notePath);

      const find = String(input['find'] ?? '');
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

      await context.app.updateNote(
        context.key.owner,
        notePath,
        note.content.replace(find, String(input['replace'] ?? '')),
        context.key.name,
      );
      context.keys.log(context.key, 'edit_note', notePath, true);
      return `Edited ${notePath}`;
    },
  },
];

function clampLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200, Math.trunc(parsed));
}
