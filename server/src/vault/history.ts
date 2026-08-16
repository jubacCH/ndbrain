/**
 * Reading the vault's history sidecar.
 *
 * `vault-history.sh` on the host commits every vault into a git repository at
 * its own root, every two minutes. That has been running for weeks and holds
 * real history — and until now nothing in the application could see it. A note
 * somebody overwrote by accident was recoverable in principle and, in practice,
 * only by somebody with a shell on the box.
 *
 * **Read-only, on purpose.** The timer on the host owns every commit. Nothing
 * here writes to the repository, which preserves the property the sidecar was
 * designed around: if git breaks, ndBrain does not notice and goes on saving
 * notes. A restore is therefore an ordinary write of old text, not a rewrite of
 * history — the version being replaced gets committed by the next tick like any
 * other edit, so undoing a restore is just another restore.
 *
 * Every git invocation goes through `execFile` with an argument array and no
 * shell. The paths are already canonical by the time they arrive, but a vault
 * path is user input that reaches a subprocess, so `--` terminates the option
 * list and a name that begins with a dash stays a name.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { NoteNotFoundError } from '../errors.js';
import { normalizeVaultPath, vaultRoot } from './paths.js';

const run = promisify(execFile);

export interface Version {
  /** Commit hash; opaque to the client, and the handle for reading or restoring. */
  id: string;
  at: number;
  /** What the sidecar recorded — a timestamp and a count, not an author. */
  subject: string;
  /** Bytes at this version, so the UI can show "grew by 400 bytes". */
  size: number;
}

/** Big enough to matter, small enough that a note edited all day stays readable. */
const MAX_VERSIONS = 50;

/**
 * A hard ceiling on how long git may take.
 *
 * A repository that has grown pathological must not turn one request into a
 * hung connection: the history is a convenience, and a slow answer to "what did
 * this look like yesterday" is better than a stuck note editor.
 */
const TIMEOUT_MS = 5000;

/**
 * The field separator, and it has to be a real NUL.
 *
 * Written as a space at first, which every test on tidy data would have passed:
 * the sidecar's subjects read `Vault-Stand 2026-08-13 21:05 · 1 geändert`, so
 * the first space would have split one record into six fields and shifted every
 * version after it. A NUL cannot occur in a commit subject, which is the whole
 * reason git offers it as a separator.
 *
 * Written as an escape rather than as the byte itself: a literal NUL in the
 * source makes the file binary to grep, diff and review tools.
 */
const NUL = '\u0000';

export class History {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  #root(owner: string): string {
    return vaultRoot(this.#dataDir, owner);
  }

  /**
   * Whether this vault has a history at all.
   *
   * False on a fresh install, in tests, and anywhere the host timer is not set
   * up. Everything else here answers empty rather than throwing in that case:
   * the absence of a sidecar is a deployment fact, not a request error.
   */
  async available(owner: string): Promise<boolean> {
    try {
      await run('git', ['rev-parse', '--git-dir'], { cwd: this.#root(owner), timeout: TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /** Every recorded version of one note, newest first. */
  async versions(owner: string, notePath: string): Promise<Version[]> {
    const path = normalizeVaultPath(notePath);

    let stdout: string;
    try {
      const result = await run(
        'git',
        [
          'log',
          `--max-count=${MAX_VERSIONS}`,
          // %x00 emits a real NUL byte; splitting on a space or a tab would
          // come apart on the first commit subject that contains one, and every
          // subject this sidecar writes contains several.
          '--format=%H%x00%at%x00%s%x00',
          '--',
          path,
        ],
        { cwd: this.#root(owner), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch {
      return [];
    }

    const fields = stdout.split(NUL);
    const out: Version[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const id = (fields[i] ?? '').trim();
      if (id === '') continue;
      out.push({
        id,
        at: Number(fields[i + 1]) * 1000,
        subject: (fields[i + 2] ?? '').trim(),
        size: 0,
      });
    }
    return out;
  }

  /**
   * The note's content at one version.
   *
   * The commit id is checked against this note's own history rather than passed
   * to git as given. Without that, any string reaching this method addresses any
   * object in the repository — and the repository holds every vault's notes,
   * which is precisely the tenant boundary the rest of the server spends its
   * time defending.
   */
  async contentAt(owner: string, notePath: string, versionId: string): Promise<string> {
    const path = normalizeVaultPath(notePath);

    const known = await this.versions(owner, path);
    if (!known.some((version) => version.id === versionId)) {
      throw new NoteNotFoundError('no such version of this note');
    }

    try {
      const { stdout } = await run('git', ['show', `${versionId}:${path}`], {
        cwd: this.#root(owner),
        timeout: TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch {
      // The commit exists and touched this path, but the path is absent *at*
      // that commit — which is what a deletion looks like from here.
      throw new NoteNotFoundError('the note did not exist at that version');
    }
  }
}
