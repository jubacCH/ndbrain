/**
 * Which file a note share names.
 *
 * A path says where a note is, not which note it is. A file renamed over the
 * note, or a delete followed at once by a new file, leaves the path in place
 * and reaches the watcher as one `change` — and ndBrain itself may write to the
 * path before the watcher has said anything. So every note share carries the
 * identity of the file it was given for and that file's content hash, and
 * everything that decides about a note share goes through here:
 *
 * - `confirm` looks at the file on the path now and withdraws the shares that
 *   were given for some other file. The watcher, reconciliation and start-up
 *   call it; so does every ndBrain write **before** it writes over a note.
 * - `rebind` moves the shares that survived `confirm` onto the file a write
 *   has just put in place, and no others.
 *
 * Both run inside the note's lock: between the look and the decision, nothing
 * else of ndBrain's can change the file.
 */

import { createHash } from 'node:crypto';

import type { Vault } from '../vault/fs.js';
import { caseKey } from '../vault/paths.js';
import type { NoteLifecycle, ShareService } from './shares.js';

/** The content hash a note share is confirmed against. */
export function contentHash(content: string | Buffer): string {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * The least content, in non-whitespace bytes, for which an equal hash may
 * vouch for a different file.
 *
 * The rescue exists for a restore or a copy onto another disk: a new file
 * carrying exactly the text the grantee was given reveals nothing new. It is
 * only sound while an equal hash really means "the same note". Empty or
 * near-empty files — a blank note, a lone heading, a template's first line —
 * coincide all the time, and a coincidence would bind the share to a stranger
 * that is filled in a moment later. 64 bytes is past every such stub (a
 * heading with a date is about 30) and still below the shortest real note
 * worth sharing; below it, only the file's own identity counts.
 */
export const RESCUE_MIN_BYTES = 64;

export function substantial(content: string | Buffer): boolean {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  let count = 0;
  for (const byte of bytes) {
    // ASCII whitespace; multi-byte characters count with every byte.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c) continue;
    count += 1;
    if (count >= RESCUE_MIN_BYTES) return true;
  }
  return false;
}

export interface CurrentFile {
  file: string;
  hash: string;
  substantial: boolean;
}

export class NoteBindings {
  readonly #shares: ShareService;
  readonly #vault: Vault;

  constructor(shares: ShareService, vault: Vault) {
    this.#shares = shares;
    this.#vault = vault;
  }

  /**
   * Withdraws the note shares on `notePath` that name a different file than
   * the one there now, and binds the rest to it. Call it holding the note's
   * lock.
   *
   * Returns the identity the surviving shares are bound to, or null when none
   * survive (or there were none).
   *
   * - No note under exactly this spelling: every share on it is withdrawn.
   * - The file they were bound to: kept, and bound to its current content, so
   *   an edit made in place (nano, VS Code, Obsidian) keeps the share.
   * - Another file with the content they were bound to, and that content is
   *   substantial (`RESCUE_MIN_BYTES`): kept and bound to the new file — a
   *   restore.
   * - Anything else: withdrawn.
   * - Never bound (granted before bindings existed): bound to what is there.
   */
  async confirm(owner: string, notePath: string): Promise<string | null> {
    const bindings = this.#shares.noteBindings(owner, notePath);
    if (bindings.length === 0) return null;

    const current = (await this.#exists(owner, notePath)) ? await this.current(owner, notePath) : null;
    if (current === null) {
      this.#shares.dropNote(owner, notePath);
      return null;
    }

    let keep = false;
    for (const binding of bindings) {
      const same =
        binding.file === null ||
        binding.file === current.file ||
        (current.substantial && binding.hash === current.hash);
      if (same) keep = true;
      else this.#shares.dropNoteBoundTo(owner, notePath, binding.file!);
    }
    if (!keep) return null;
    this.#shares.bindNote(owner, notePath, current.file, current.hash);
    return current.file;
  }

  /**
   * After a write put a new file at `notePath`: the shares bound to
   * `confirmed` — what `confirm` returned before the write — follow it to the
   * new file. A share bound to anything else is not ndBrain's to carry over,
   * and a null `confirmed` carries nothing. Call it holding the note's lock.
   */
  async rebind(owner: string, notePath: string, confirmed: string | null): Promise<void> {
    if (confirmed === null) return;
    const current = await this.current(owner, notePath);
    if (current === null) {
      this.#shares.dropNoteBoundTo(owner, notePath, confirmed);
      return;
    }
    this.#shares.rebindNote(owner, notePath, confirmed, current.file, current.hash);
  }

  /** Binds every share on `notePath` to the file there now, as a new grant does. */
  async bindAll(owner: string, notePath: string): Promise<void> {
    const current = await this.current(owner, notePath);
    if (current !== null) this.#shares.bindNote(owner, notePath, current.file, current.hash);
  }

  /** The file at `notePath` with its content hash, or null when there is none. */
  async current(owner: string, notePath: string): Promise<CurrentFile | null> {
    const file = await this.#vault.fileIdentity(owner, notePath);
    if (file === null) return null;
    try {
      const content = await this.#vault.readNote(owner, notePath);
      // Read twice around the content: a file swapped in between would bind
      // this content to the wrong file.
      if ((await this.#vault.fileIdentity(owner, notePath)) !== file) return null;
      return { file, hash: contentHash(content), substantial: substantial(content) };
    } catch {
      return null;
    }
  }

  /** Under exactly this spelling: `stat` folds letter case on macOS and Windows. */
  async #exists(owner: string, notePath: string): Promise<boolean> {
    const siblings = await this.#vault.siblingCaseKeys(owner, notePath);
    const name = notePath.slice(notePath.lastIndexOf('/') + 1);
    return siblings.get(caseKey(name)) === name;
  }
}

/** The hooks the note write path calls from inside its lock. */
export function noteLifecycle(shares: ShareService, bindings: NoteBindings): NoteLifecycle {
  return {
    created: (owner, notePath) => shares.dropNote(owner, notePath),
    moved: (owner, from, to) => shares.moveNote(owner, from, to),
    removed: (owner, notePath) => shares.dropNote(owner, notePath),
    confirm: (owner, notePath) => bindings.confirm(owner, notePath),
    rebind: (owner, notePath, confirmed) => bindings.rebind(owner, notePath, confirmed),
  };
}
