/**
 * Keeps the index in step with edits made outside the server.
 *
 * The vault is a plain folder, so notes legitimately change behind our back: an
 * rsync, a `git pull`, Obsidian on a mounted share, or somebody with an SSH
 * session and vim. If those edits did not reach the index, search would quietly
 * go stale — the exact failure that is hardest to notice.
 *
 * Suppressing the server's own writes is done by comparing content hashes rather
 * than by ignoring events for a short window after a write. A window is a guess:
 * too short and a fast external edit is dropped, too long and a real change is
 * ignored. A hash comparison is simply correct, and costs one read of a file we
 * were about to read anyway.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import type { Indexer } from './indexer.js';
import { assertUserId, isNotePath } from '../vault/paths.js';

export interface WatcherOptions {
  /**
   * How long to wait for a burst of events to settle. Editors write in several
   * steps (truncate, write, rename), and a `git checkout` touches many files at
   * once; batching turns that into one indexing pass.
   */
  debounceMs?: number;
  /**
   * How often to reconcile the whole vault against the index. Zero disables it.
   *
   * This is not belt-and-braces, it is the correctness guarantee — see
   * `reconcile()`. Five minutes is frequent enough that a missed event is never
   * noticed and cheap enough to be invisible: the sweep compares hashes and
   * touches only what differs.
   */
  reconcileIntervalMs?: number;
  /** Called after each batch — used by tests and, later, by the live UI. */
  onBatch?: (changed: Map<string, Set<string>>) => void;
  onError?: (error: unknown) => void;
  /**
   * A note was deleted on disk, whether or not something has appeared under
   * its name since. Called once per note per batch, before it is reindexed.
   */
  onNoteRemoved?: (owner: string, notePath: string) => void;
  /**
   * A note's file was reported changed and not deleted in this batch. The
   * event cannot say whether it is the same file: a file renamed over the note,
   * or a delete followed at once by a new file, arrive as a `change` too.
   * Called before the note is reindexed.
   */
  onNoteChanged?: (owner: string, notePath: string) => Promise<void>;
  /**
   * Before a reconcile syncs one vault — for what the events missed.
   *
   * Before and not after, for the same reason `onNoteChanged` runs before the
   * note is reindexed: a note share that no longer names its file has to go
   * before that file's words are indexed under it.
   */
  beforeSync?: (owner: string) => Promise<void>;
}

interface PendingChange {
  owner: string;
  notePath: string;
  removed: boolean;
  /**
   * Whether the file was unlinked at any point in this batch. Sticky, unlike
   * `removed`: a delete followed by an add of the same name inside one debounce
   * window must still count as the note going, or the add would quietly hand
   * the new file whatever was attached to the old one.
   */
  unlinked: boolean;
}

export class VaultWatcher {
  readonly #vaultsDir: string;
  readonly #indexer: Indexer;
  readonly #debounceMs: number;
  readonly #onBatch: ((changed: Map<string, Set<string>>) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onNoteRemoved: ((owner: string, notePath: string) => void) | undefined;
  readonly #onNoteChanged: ((owner: string, notePath: string) => Promise<void>) | undefined;
  readonly #beforeSync: ((owner: string) => Promise<void>) | undefined;

  readonly #reconcileIntervalMs: number;

  readonly #pending = new Map<string, PendingChange>();
  #timer: NodeJS.Timeout | null = null;
  #reconcileTimer: NodeJS.Timeout | null = null;
  #flushing: Promise<void> = Promise.resolve();
  #watcher: FSWatcher | null = null;

  constructor(dataDir: string, indexer: Indexer, options: WatcherOptions = {}) {
    this.#vaultsDir = path.resolve(dataDir, 'vaults');
    this.#indexer = indexer;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#reconcileIntervalMs = options.reconcileIntervalMs ?? 5 * 60 * 1000;
    this.#onBatch = options.onBatch;
    this.#onError = options.onError;
    this.#onNoteRemoved = options.onNoteRemoved;
    this.#onNoteChanged = options.onNoteChanged;
    this.#beforeSync = options.beforeSync;
  }

  async start(): Promise<void> {
    if (this.#watcher !== null) return;

    this.#watcher = chokidar.watch(this.#vaultsDir, {
      ignoreInitial: true,
      // Do not follow symlinks: the vault layer refuses to read through them, so
      // watching them would produce events for notes that can never be indexed.
      followSymlinks: false,
      // Report a delete as a delete even when a file of the same name appears
      // right after it. chokidar's default folds an unlink and an add inside
      // 100 ms into one `change`, and a change carries note shares over — so a
      // note replaced by a different file would hand its grants to the stranger.
      // ndBrain's own saves are unaffected: they rename a finished temporary
      // file over the note, so the path is never missing.
      //
      // This only helps when the new file is slow to arrive. A delete followed
      // at once by a new file still reaches us as one `change` on Linux and
      // macOS alike, and a file renamed over the note never leaves the path
      // missing at all — which is why a `change` asks `onNoteChanged` whether
      // it is still the same file.
      atomic: false,
      ignored: (target: string) => {
        const relative = path.relative(this.#vaultsDir, target);
        if (relative.startsWith('..')) return true;
        // Hidden directories (.git, .obsidian) and our own atomic-write temp files.
        return relative.split(path.sep).some((segment) => segment.startsWith('.'))
          || target.endsWith('.tmp');
      },
      awaitWriteFinish: {
        // A large paste or a slow network share can arrive in pieces; indexing a
        // half-written file would record a note that never existed.
        stabilityThreshold: 120,
        pollInterval: 30,
      },
    });

    this.#watcher
      .on('add', (file) => this.#queue(file, false))
      .on('change', (file) => this.#queue(file, false))
      .on('unlink', (file) => this.#queue(file, true))
      .on('error', (error) => this.#onError?.(error));

    await new Promise<void>((resolve) => {
      this.#watcher?.once('ready', () => resolve());
    });

    if (this.#reconcileIntervalMs > 0) {
      this.#reconcileTimer = setInterval(() => {
        void this.reconcile().catch((error) => this.#onError?.(error));
      }, this.#reconcileIntervalMs);
      this.#reconcileTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#reconcileTimer !== null) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = null;
    }
    await this.#flushing;
    await this.#watcher?.close();
    this.#watcher = null;
  }

  /**
   * Walks every vault and brings the index back in line with the files.
   *
   * File watchers lose events, and not rarely: inotify has a per-user watch
   * limit that a large vault can exhaust, network shares and container bind
   * mounts deliver events unreliably, and chokidar's write-settling deliberately
   * withholds a file until it stops changing — so a note created and deleted
   * inside that window is announced neither as added nor as removed.
   *
   * So the watcher provides latency and this provides correctness. Without it,
   * the failure mode is an index that is subtly wrong for as long as the process
   * runs, which is exactly the kind of bug that surfaces as "search sometimes
   * doesn't find things" months later.
   */
  async reconcile(): Promise<void> {
    for (const owner of await this.#owners()) {
      try {
        // The shares first: a note replaced or removed without an event has
        // to stop being shared before its replacement's words reach the
        // index, or the reconcile is itself the leak it exists to repair.
        await this.#beforeSync?.(owner);
        await this.#indexer.sync(owner);
      } catch (error) {
        this.#onError?.(error);
      }
    }
  }

  async #owners(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.#vaultsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertUserId(name);
          return true;
        } catch {
          return false;
        }
      });
  }

  /** Processes everything queued right now. Exposed so tests need no sleeps. */
  async flushNow(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#flush();
  }

  #queue(absolute: string, removed: boolean): void {
    const parsed = this.#locate(absolute);
    if (parsed === null) return;

    const key = `${parsed.owner}\u0000${parsed.notePath}`;
    const unlinked = removed || this.#pending.get(key)?.unlinked === true;
    this.#pending.set(key, { ...parsed, removed, unlinked });

    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flush();
    }, this.#debounceMs);
  }

  /** Maps an absolute path to `(owner, vault-relative path)`, or null if irrelevant. */
  #locate(absolute: string): { owner: string; notePath: string } | null {
    const relative = path.relative(this.#vaultsDir, path.resolve(absolute));
    if (relative === '' || relative.startsWith('..')) return null;

    const segments = relative.split(path.sep);
    const owner = segments.shift();
    if (owner === undefined || segments.length === 0) return null;

    try {
      assertUserId(owner);
    } catch {
      return null; // a stray directory that is not a vault
    }

    const notePath = segments.join('/');
    return isNotePath(notePath) ? { owner, notePath } : null;
  }

  async #flush(): Promise<void> {
    if (this.#pending.size === 0) return;

    const batch = [...this.#pending.values()];
    this.#pending.clear();

    this.#flushing = this.#flushing.then(async () => {
      const touched = new Map<string, Set<string>>();

      for (const change of batch) {
        try {
          if (change.unlinked) this.#onNoteRemoved?.(change.owner, change.notePath);
          else if (!change.removed) await this.#onNoteChanged?.(change.owner, change.notePath);

          if (change.removed) {
            this.#indexer.removeNote(change.owner, change.notePath);
          } else {
            const result = await this.#indexer.indexIfChanged(change.owner, change.notePath);
            // 'unchanged' means the server wrote it and already indexed it.
            if (result === 'unchanged') continue;
            if (result === 'missing') {
              // Created and deleted again before we got here.
              this.#indexer.removeNote(change.owner, change.notePath);
            }
          }

          const set = touched.get(change.owner) ?? new Set<string>();
          set.add(change.notePath);
          touched.set(change.owner, set);
        } catch (error) {
          // One unreadable note must not stop the batch — the rest of the vault
          // still needs to reach the index.
          this.#onError?.(error);
        }
      }

      // Links are resolved once per owner per batch: a `git pull` that adds
      // fifty notes should re-resolve once, not fifty times.
      for (const owner of touched.keys()) {
        this.#indexer.resolveLinks(owner);
      }

      if (touched.size > 0) this.#onBatch?.(touched);
    });

    await this.#flushing;
  }
}
