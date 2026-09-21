/**
 * Recently deleted notes, and bringing one back.
 *
 * Since notes can be deleted, the confirmation promised that earlier versions
 * stay in the history. They did — but the history hangs off an open note, and a
 * deleted note cannot be opened, so the only way back was git on the host.
 * This puts the way back into the application, built from two things that
 * already exist: the `edits` log, which knows what was deleted, by whom and
 * when, and the sidecar repository, which holds what the note said.
 *
 * **Who.** Only somebody who could write the note back where it was: the owner,
 * or a person holding a vault or folder share with write access over the path
 * (`restoreScopes`). A note share never counts — deleting the note withdrew it,
 * and the title and path of a deleted note are content like any other. For
 * everybody else a deleted note is exactly a note that never existed: missing
 * from the list, and answered with the same 404 on a restore.
 *
 * **How.** A restore is an ordinary create through the one write path, inside
 * the note's lock: it is indexed, logged as a create, and like every new file
 * it inherits no share. Where the old path is taken by now, the note comes back
 * next to it under `restoredPath`, never over what is there.
 */

import { NoteNotFoundError, NothingToRestoreError } from '../errors.js';
import type { ShareService } from '../auth/shares.js';
import type { App } from '../app.js';
import type { History, HistoryState } from '../vault/history.js';
import { inScope } from '../auth/shares.js';
import { restoredPath, restoreScopes, type DeletedRow } from '../index/queries.js';
import { CaseCollisionError } from '../errors.js';
import { normalizeVaultPath } from '../vault/paths.js';
import { KeyedMutex } from './mutex.js';
import type { Note } from './service.js';

/** How far back the list reaches. */
export const DELETED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a deleted note can be brought back, and if not, why.
 *
 * - `ready`: a saved version exists.
 * - `no-history`: the host keeps no history for this vault.
 * - `no-commit`: it does, but nothing has been recorded yet.
 * - `no-version`: history exists, but no saved version holds this note — it
 *   was created and deleted between two ticks of the timer.
 */
export type RestoreState = 'ready' | 'no-history' | 'no-commit' | 'no-version';

export interface DeletedNote extends DeletedRow {
  folder: string;
  restore: RestoreState;
  /** When the version a restore would bring back was saved; null unless `ready`. */
  savedAt: number | null;
}

export interface RestoreResult {
  note: Note;
  /** False when the old path was taken and the note came back under another name. */
  samePath: boolean;
}

/** What a delete about to happen leaves behind; see `DeletedNotes.preview`. */
export interface DeletePreview {
  /** Notes that could be brought back afterwards. */
  restorable: number;
  /** Notes the caller could bring back, but no saved version holds. */
  unsaved: number;
  /** Notes the caller could not bring back at all, whatever the host keeps. */
  notYours: number;
  /** Whether the host keeps any history where the caller could restore. */
  history: boolean;
}

/** How many other names a restore tries before it gives up. */
const MAX_NAME_ATTEMPTS = 50;

export class DeletedNotes {
  readonly #app: App;
  readonly #shares: ShareService;
  readonly #history: History;
  /** One restore of a path at a time, so a double click cannot bring a note back twice. */
  readonly #restoring = new KeyedMutex();

  constructor(app: App, shares: ShareService, history: History) {
    this.#app = app;
    this.#shares = shares;
    this.#history = history;
  }

  /** May `caller` bring back a note at `path` in `owner`'s vault? */
  #mayRestore(caller: string, owner: string, path: string): boolean {
    return restoreScopes(this.#shares.view(caller)).some(
      (scope) => scope.owner === owner && inScope(scope, path),
    );
  }

  /**
   * The same question as a gate: the answer for a caller without the right is
   * the answer for a note that never existed.
   *
   * Written as a function so it can be handed to the write path as its
   * `authorize` hook, which re-checks the right inside the note's lock — see
   * the one call site in `restore`.
   */
  #assertMayRestore(caller: string, owner: string, path: string): void {
    if (!this.#mayRestore(caller, owner, path)) throw new NoteNotFoundError('note does not exist');
  }

  /** The notes `caller` may bring back, deleted within the window. */
  async list(caller: string, now = Date.now()): Promise<DeletedNote[]> {
    const rows = this.#app.queries.deletedNotes(this.#shares.view(caller), now - DELETED_WINDOW_MS);
    const states = new Map<string, HistoryState>();
    const out: DeletedNote[] = [];
    for (const row of rows) {
      let state = states.get(row.owner);
      if (state === undefined) {
        state = await this.#history.state(row.owner);
        states.set(row.owner, state);
      }
      const version = state === 'ready' ? await this.#version(caller, row.owner, row.path, row.at) : null;
      out.push({
        ...row,
        folder: row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : '',
        restore: state === 'none' ? 'no-history' : state === 'empty' ? 'no-commit' : version === null ? 'no-version' : 'ready',
        savedAt: version?.at ?? null,
      });
    }
    return out;
  }

  /**
   * The saved version a restore brings back: the last one before the delete,
   * and never one from before the caller's view of the path began.
   */
  async #version(caller: string, owner: string, path: string, deletedAt: number) {
    const from = this.#shares.pastVisibleFrom(caller, owner, path);
    return this.#history.lastVersionBefore(owner, path, deletedAt, from);
  }

  /**
   * Brings a deleted note back.
   *
   * Refused with `NoteNotFoundError` — the answer for a note that never
   * existed — when the caller may not restore there, and equally when the path
   * holds no deleted note in the window. The two are decided before anything
   * else is looked at, so neither the history nor the vault can tell them apart.
   */
  async restore(caller: string, owner: string, notePath: string, now = Date.now()): Promise<RestoreResult> {
    const path = normalizeVaultPath(notePath);
    this.#assertMayRestore(caller, owner, path);

    return this.#restoring.run(`${owner}:${path}`, async () => {
      // Looked up again under the lock: a restore that got here first has
      // logged a create, and the note is no longer deleted.
      const [row] = this.#app.queries.deletedNotes(this.#shares.view(caller), now - DELETED_WINDOW_MS, 1, {
        owner,
        path,
      });
      if (row === undefined) throw new NoteNotFoundError('note does not exist');

      if ((await this.#history.state(owner)) !== 'ready') {
        throw new NothingToRestoreError('no saved version of this note exists');
      }
      const version = await this.#version(caller, owner, path, row.at);
      if (version === null) throw new NothingToRestoreError('no saved version of this note exists');
      const content = await this.#history.contentAt(owner, path, version.id);

      const when = new Date(now);
      for (let attempt = 0; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
        const target = attempt === 0 ? path : restoredPath(path, when, attempt);
        const authorize = (): void => this.#assertMayRestore(caller, owner, target);
        // Checked again for the name actually written, which a taken path
        // moves. On a branch where the write path takes an `authorize` hook,
        // this call passes `{ authorize }` as its fifth argument and the same
        // right is re-checked inside the note's lock.
        authorize();
        let result;
        try {
          result = await this.#app.createNoteIfAbsent(owner, target, content, caller);
        } catch (error) {
          // A differently-cased note holds the name: taken, like an equal one.
          if (error instanceof CaseCollisionError) continue;
          throw error;
        }
        if (result.created) return { note: result.note, samePath: attempt === 0 };
      }
      throw new NothingToRestoreError('no free name to restore this note under');
    });
  }

  /**
   * What deleting `paths` would leave for `caller` to bring back.
   *
   * Asked before the confirmation, so it can say honestly whether the notes can
   * come back instead of promising a history that may not be there. A path the
   * caller may not restore counts as `notYours` without anything being looked
   * up for it, so the answer says nothing about it that the caller did not send.
   */
  async preview(caller: string, owner: string, paths: string[]): Promise<DeletePreview> {
    const canonical = paths.map((notePath) => normalizeVaultPath(notePath));
    const mine = canonical.filter((path) => this.#mayRestore(caller, owner, path));
    const out: DeletePreview = { restorable: 0, unsaved: 0, notYours: canonical.length - mine.length, history: false };
    if (mine.length === 0) return out;

    const state = await this.#history.state(owner);
    out.history = state !== 'none';
    if (state !== 'ready') {
      out.unsaved = mine.length;
      return out;
    }
    const recorded = await this.#history.recorded(owner, mine);
    for (const path of mine) {
      if (recorded.has(path)) out.restorable += 1;
      else out.unsaved += 1;
    }
    return out;
  }
}
