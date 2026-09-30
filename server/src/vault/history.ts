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
 * **Nothing here answers "no history" for a question it could not ask.** Every
 * method used to end in `catch { return empty }`, which made five different
 * situations look identical to "this note was never changed": a repository that
 * is not there, one that is corrupt, a git that cannot be run, a vault the
 * container may not read, and a call that ran into the timeout. A way back that
 * switches itself off in silence is worse than none, because it is discovered on
 * the day it is needed. So a failure is now sorted into exactly one of three
 * things — see `GitFailure` — and only the first of them is allowed to read as
 * an absence.
 *
 * Every git invocation goes through `execFile` with an argument array and no
 * shell. The paths are already canonical by the time they arrive, but a vault
 * path is user input that reaches a subprocess, so `--` terminates the option
 * list and a name that begins with a dash stays a name.
 */

import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { HistoryUnreadableError, NoteNotFoundError } from '../errors.js';
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

/**
 * A version, plus the name the file carried in that commit.
 *
 * Not the same as today's path once a rename is in the history, which is the
 * whole reason this exists: `git show <commit>:<path>` addresses the tree of
 * that commit, where the note is still filed under its old name.
 *
 * Server-side only, deliberately. It never reaches `Version` and so never
 * reaches a client: somebody lent a single note through a share has no business
 * learning which folder it used to live in, and the old path would say.
 */
interface VersionAt extends Version {
  pathAt: string;
}

/**
 * What the host keeps for a vault; see `History.state`.
 *
 * - `none`: no repository. A fresh install, a test, a host without the timer.
 * - `empty`: a repository, and nothing committed into it yet.
 * - `ready`: a repository with history.
 * - `broken`: there is one and it could not be read. The one state that is a
 *   defect rather than a deployment fact, and the reason this union has a
 *   fourth member at all: the other three were being used to report it.
 */
export type HistoryState = 'none' | 'empty' | 'ready' | 'broken';

/** What one note's history amounts to: the versions, and whether that is the whole truth. */
export interface HistoryView {
  /**
   * Never `empty` for a repository that has commits but none touching this
   * note — that is `ready` with an empty list, and the distinction is the
   * point. `none` and `empty` are what git itself said; `ready` does not
   * promise the vault is the repository's top level, which only `state` asks.
   */
  state: HistoryState;
  versions: Version[];
}

/** Why an operator is being told the sidecar cannot be read. */
export interface UnreadableHistory {
  owner: string;
  /** git's own first line, or what stopped it being asked. Never a note's content. */
  reason: string;
}

export interface HistoryOptions {
  /**
   * Where an unreadable sidecar gets reported. Installed by `buildServer` from
   * Fastify's logger; absent everywhere else, because the CLI builds a runtime
   * too and a warning with nowhere to go must not be a crash.
   */
  warn?: (detail: UnreadableHistory) => void;
  /**
   * Overridden only by the tests that have to produce a timeout, which need git
   * to be killed in milliseconds rather than in five seconds.
   */
  timeoutMs?: number;
}

/** Big enough to matter, small enough that a note edited all day stays readable. */
const MAX_VERSIONS = 50;

/**
 * A hard ceiling on how long git may take.
 *
 * A repository that has grown pathological must not turn one request into a
 * hung connection: the history is a convenience, and a slow answer to "what did
 * this look like yesterday" is better than a stuck note editor.
 *
 * It will be reached. At one commit every two minutes a vault gathers a quarter
 * of a million commits a year, and `git log -- <path>` walks back from HEAD
 * until it has found fifty commits touching that one path — for a note nobody
 * has edited in months, that is the whole history. Which is exactly why running
 * into it may not look like "no versions".
 */
const TIMEOUT_MS = 5000;

/**
 * How long one warning about a vault stands for the next.
 *
 * A sidecar that is broken is broken for every request, and the note list alone
 * asks about it once per open note. Without this, one misconfigured vault fills
 * the log faster than anybody can read it and the line that matters is the one
 * scrolling past. Same reasoning, and the same minute, as `HISTORY_TTL_MS` in
 * the health endpoint.
 */
const WARN_TTL_MS = 60_000;

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

/**
 * A full commit hash, used to find where each entry starts in git's output.
 *
 * Anchoring on this rather than on a field count: the listing interleaves
 * commit metadata with file names, and a commit that reports a different number
 * of names than expected would otherwise shift every field after it.
 */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/**
 * What git says when it did not find a repository — for four different reasons.
 *
 * Verified against git 2.51 rather than assumed: a directory that never had a
 * repository, one whose `.git/objects` has been deleted, one whose `.git` the
 * process may not read, and one whose `HEAD` contains junk all produce this one
 * message. Repository discovery validates the layout before accepting a
 * directory and then walks up to the parents, so a broken `.git` is not a
 * broken repository to git — it is no repository, same as bare ground.
 *
 * Three of those four are defects. Since the message cannot tell them apart,
 * `#classify` looks on disk instead; see there.
 */
const NOT_A_REPOSITORY = /not a git repository/i;

/** An unborn branch: a repository exists and the timer has not committed yet. */
const NO_COMMITS_YET = /does not have any commits yet/i;

/**
 * The path is not in that commit — which is what a deletion looks like from
 * here. The second wording is what git says when the file is in the working
 * tree but not in the tree being asked about.
 */
const PATH_ABSENT_AT_COMMIT = /does not exist in|exists on disk, but not in/i;

/**
 * Why a git invocation did not answer.
 *
 * The whole reason this type exists is that the three are not interchangeable
 * and used to be:
 *
 * - `absent` — there is no repository, and nothing on disk claiming there is.
 *   A deployment fact, and the only one a caller may report as an absence.
 * - `refused` — git ran and said no for a reason the caller may be expecting,
 *   such as an unborn branch or a path that is not in a commit. The caller
 *   decides by reading `stderr`, and anything it does not recognise is a defect.
 * - `unreadable` — git could not be asked, or answered something nobody
 *   planned for. Always a defect, always reported.
 */
type GitFailure =
  | { kind: 'absent' }
  | { kind: 'refused'; code: number; stderr: string }
  | { kind: 'unreadable'; reason: string };

/** git's own complaint, trimmed to the line that says what went wrong. */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  return (line ?? '').trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export class History {
  readonly #dataDir: string;
  readonly #timeoutMs: number;
  /** Where a defect is reported; see `reportTo`. */
  #warn: (detail: UnreadableHistory) => void;
  /** When each owner was last complained about; see `WARN_TTL_MS`. */
  readonly #warned = new Map<string, number>();

  constructor(dataDir: string, options: HistoryOptions = {}) {
    this.#dataDir = dataDir;
    this.#warn = options.warn ?? ((): void => {});
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  #root(owner: string): string {
    return vaultRoot(this.#dataDir, owner);
  }

  /**
   * Where an unreadable sidecar gets reported, once the logger exists.
   *
   * The runtime is built before the server that owns the logger — the same
   * order `main.ts` works around for its indexing warnings — so the sink is
   * installed afterwards rather than making the runtime depend on the HTTP
   * layer. `buildServer` does it for every server, the test harness included,
   * so what the tests check is the wiring that ships.
   */
  reportTo(warn: (detail: UnreadableHistory) => void): void {
    this.#warn = warn;
  }

  #run(
    root: string,
    args: string[],
    options: { maxBuffer?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, {
      cwd: root,
      timeout: this.#timeoutMs,
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
      // `LC_ALL` is load-bearing rather than tidy. Two decisions below are made
      // by reading git's own words — "does not have any commits yet" and "does
      // not exist in <commit>" — and git translates them. On a host with a
      // German locale, a repository the timer has not committed into yet would
      // otherwise be reported as broken. Read fresh each call so a test can put
      // something in front of it.
      //
      // The rest of the environment is passed through deliberately: a
      // `safe.directory` exception an operator added lives in the global git
      // config, and a sidecar that works only because of one has to keep
      // working.
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
    });
  }

  /**
   * Sorts one failed invocation into the three things it can be.
   *
   * The interesting half is `NOT_A_REPOSITORY`. git says it for a vault that
   * never had a sidecar and for one whose `.git` is there but unusable, so the
   * message is not evidence — the directory is. `.git` present and git refusing
   * to see a repository means something broke it: deleted objects, a `HEAD`
   * full of junk, or the ownership case this server actually meets, where the
   * container runs as uid 1000 and the repository on the host belongs to root,
   * and git answers "detected dubious ownership". One `stat`, no subprocess.
   *
   * `ENOENT` is the other doubled-up answer: `execFile` reports it both when
   * git is not on the PATH and when `cwd` does not exist. Only the second is
   * allowed to mean "no history" — a missing vault directory has no history by
   * definition, a missing git is a broken installation.
   */
  async #classify(root: string, error: unknown): Promise<GitFailure> {
    const caught = error as { code?: unknown; killed?: unknown; stderr?: unknown };
    const stderr = typeof caught.stderr === 'string' ? caught.stderr : '';

    if (caught.killed === true) {
      return { kind: 'unreadable', reason: `git did not answer within ${this.#timeoutMs}ms` };
    }
    if (typeof caught.code === 'string') {
      if (caught.code === 'ENOENT' && !(await exists(root))) return { kind: 'absent' };
      return { kind: 'unreadable', reason: `git could not be run (${caught.code})` };
    }
    if (typeof caught.code !== 'number') {
      return { kind: 'unreadable', reason: firstLine(stderr) || 'git failed without an exit status' };
    }
    if (NOT_A_REPOSITORY.test(stderr)) {
      return (await exists(path.join(root, '.git')))
        ? { kind: 'unreadable', reason: firstLine(stderr) }
        : { kind: 'absent' };
    }
    return { kind: 'refused', code: caught.code, stderr };
  }

  /**
   * Says it out loud, at most once a minute per vault.
   *
   * Because the alternative is that nobody finds out. An operator whose sidecar
   * has been failing for three weeks should be able to grep for it rather than
   * open a note and notice the list is short, so the marker is fixed and the
   * reason is git's own first line.
   */
  #report(owner: string, reason: string, now = Date.now()): void {
    const last = this.#warned.get(owner);
    if (last !== undefined && now - last < WARN_TTL_MS) return;
    this.#warned.set(owner, now);
    this.#warn({ owner, reason });
  }

  /** What to put in the log for a failure that turned out to be a defect. */
  static #reasonOf(failure: GitFailure): string {
    if (failure.kind === 'unreadable') return failure.reason;
    if (failure.kind === 'refused') return firstLine(failure.stderr) || `git exited ${failure.code}`;
    // Only reachable where an earlier call had just found a repository, so the
    // repository disappeared between two invocations.
    return 'the repository is no longer there';
  }

  /** The state a defect maps to, reported on the way. */
  #brokenBy(owner: string, failure: GitFailure): 'broken' {
    this.#report(owner, History.#reasonOf(failure));
    return 'broken';
  }

  #unreadable(owner: string, failure: GitFailure): HistoryUnreadableError {
    this.#brokenBy(owner, failure);
    return new HistoryUnreadableError('the history could not be read');
  }

  /**
   * What the sidecar holds for this vault, told apart the way a deleted note's
   * restore needs it: no repository of its own, a repository without a single
   * commit yet, one with history, or one that could not be read.
   *
   * A vault that merely sits somewhere inside a repository answers `none`. That
   * is harmless for listing a note's versions, which come back empty anyway,
   * but a promise that a deleted note can be brought back has to rest on the
   * vault's own repository, so its top level must be the vault.
   *
   * Two invocations, which is what it took before: whether there is a
   * repository here, and whether it holds anything. The second one is `git log`
   * rather than `rev-parse --verify HEAD`, and that is the fix for a real hole
   * — `rev-parse --verify --quiet HEAD^{commit}` exits 1 both for an unborn
   * branch and for a branch pointing at an object that is gone, so a corrupt
   * repository reported itself as "nothing saved yet". `git log` says "does not
   * have any commits yet" for the first and "bad object HEAD" for the second.
   */
  async state(owner: string): Promise<HistoryState> {
    const root = this.#root(owner);

    let toplevel: string;
    try {
      toplevel = (await this.#run(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
    } catch (error) {
      const failure = await this.#classify(root, error);
      return failure.kind === 'absent' ? 'none' : this.#brokenBy(owner, failure);
    }

    try {
      if ((await realpath(toplevel)) !== (await realpath(root))) return 'none';
    } catch (error) {
      // git named a top level in a directory it had just run in, and it does
      // not resolve. Nothing normal produces that.
      this.#report(owner, `the repository path could not be resolved (${String(error)})`);
      return 'broken';
    }

    try {
      await this.#run(root, ['log', '--max-count=1', '--format=%H']);
      return 'ready';
    } catch (error) {
      const failure = await this.#classify(root, error);
      if (failure.kind === 'refused' && NO_COMMITS_YET.test(failure.stderr)) return 'empty';
      if (failure.kind === 'absent') return 'none';
      return this.#brokenBy(owner, failure);
    }
  }

  /**
   * The newest recorded version of `notePath` taken no later than `before` and
   * no earlier than `from` in which the note actually exists — its last saved
   * state before it was deleted. Null when there is none.
   *
   * A commit that touched the path may be the one that recorded its deletion,
   * so each candidate is asked whether the file is there at all. Only that
   * answer is allowed to move on to the next candidate: a `cat-file` that fails
   * for any other reason means the question was never answered, and a restore
   * offered on the strength of it would be a promise nobody checked.
   */
  async lastVersionBefore(owner: string, notePath: string, before: number, from = 0): Promise<Version | null> {
    const notePathCanonical = normalizeVaultPath(notePath);
    const root = this.#root(owner);
    const view = await this.versions(owner, notePathCanonical);
    if (view.state === 'broken') throw new HistoryUnreadableError('the history could not be read');

    for (const version of view.versions) {
      if (version.at > before || version.at < from) continue;
      try {
        await this.#run(root, ['cat-file', '-e', `${version.id}:${notePathCanonical}`]);
        return version;
      } catch (error) {
        const failure = await this.#classify(root, error);
        if (failure.kind === 'refused' && PATH_ABSENT_AT_COMMIT.test(failure.stderr)) continue;
        throw this.#unreadable(owner, failure);
      }
    }
    return null;
  }

  /**
   * Which of `paths` the latest commit holds. One tree listing for any number of
   * notes, so a bulk delete can say how many of them could be brought back.
   *
   * Only ever called for a vault `state` has just called `ready`, so every way
   * this can fail is a defect: the repository was there a moment ago. It throws
   * rather than returning an empty set, because an empty set here is read as
   * "none of these notes was ever saved" and put in front of somebody about to
   * delete them.
   */
  async recorded(owner: string, paths: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (paths.length === 0) return out;
    const root = this.#root(owner);

    let stdout: string;
    try {
      const result = await this.#run(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
        maxBuffer: 32 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      throw this.#unreadable(owner, await this.#classify(root, error));
    }

    const wanted = new Set(paths.map((notePath) => normalizeVaultPath(notePath)));
    for (const name of stdout.split(NUL)) {
      if (wanted.has(name)) out.add(name);
    }
    return out;
  }

  /**
   * Every recorded version of one note, newest first — and what that emptiness
   * means when there are none.
   *
   * This is the method the whole file was named after: it answered `[]` for a
   * corrupt repository, a missing git, a vault it could not read and a call
   * that timed out, and every one of them displayed as "no earlier versions
   * recorded yet". `git log` exiting 0 with no output is the only thing that
   * honestly means that, and it is the only thing that produces `ready` here.
   */
  async versions(owner: string, notePath: string): Promise<HistoryView> {
    const { state, versions } = await this.#versionsAt(owner, notePath);
    // `pathAt` is dropped here rather than never collected: reading a version
    // needs it, and the client must not have it.
    return { state, versions: versions.map(({ pathAt: _pathAt, ...rest }) => rest) };
  }

  /** As `versions`, keeping the name each version was filed under. */
  async #versionsAt(
    owner: string,
    notePath: string,
  ): Promise<{ state: HistoryState; versions: VersionAt[] }> {
    const notePathCanonical = normalizeVaultPath(notePath);
    const root = this.#root(owner);

    let stdout: string;
    try {
      const result = await this.#run(
        root,
        [
          'log',
          // Across a rename, or a note's past stops at the day it got its
          // name. `git log -- <path>` walks only the commits that touched that
          // exact name, so a renamed note showed one version and read as
          // though it had never been edited — indistinguishable from a note
          // with no history at all. Valid for a single path, which is what
          // this passes, and dependent on git's rename detection: a rename
          // that also rewrites most of the content is not recognised.
          '--follow',
          `--max-count=${MAX_VERSIONS}`,
          // %x00 emits a real NUL byte; splitting on a space or a tab would
          // come apart on the first commit subject that contains one, and every
          // subject this sidecar writes contains several.
          // The name in each commit, so a version from before a rename can be
          // read afterwards. `-z` makes git separate the names with NUL too,
          // which matters because a note may legitimately be called
          // "Sitzung\nNotizen.md" — splitting the names on a newline would cut
          // such a path in half and address a file that does not exist.
          '-z',
          '--name-only',
          '--format=%H%x00%at%x00%s',
          '--',
          notePathCanonical,
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (error) {
      const failure = await this.#classify(root, error);
      if (failure.kind === 'absent') return { state: 'none', versions: [] };
      if (failure.kind === 'refused' && NO_COMMITS_YET.test(failure.stderr)) {
        return { state: 'empty', versions: [] };
      }
      return { state: this.#brokenBy(owner, failure), versions: [] };
    }

    // `<hash> NUL <at> NUL <subject> NUL "\n" <path> NUL` per commit. The loop
    // finds each group by recognising the hash rather than by counting from the
    // start, so a commit that reports no name — or more than one — costs that
    // entry instead of shifting every field after it by one and turning the
    // rest of the list into nonsense.
    const fields = stdout.split(NUL);
    const out: VersionAt[] = [];
    for (let i = 0; i < fields.length; i += 1) {
      const id = (fields[i] ?? '').trim();
      if (!COMMIT_ID.test(id)) continue;
      const pathAt = (fields[i + 3] ?? '').trim();
      if (pathAt === '') continue;
      out.push({
        id,
        at: Number(fields[i + 1]) * 1000,
        subject: (fields[i + 2] ?? '').trim(),
        size: 0,
        pathAt,
      });
      i += 3;
    }
    return { state: 'ready', versions: out };
  }

  /**
   * The note's content at one version.
   *
   * The commit id is checked against this note's own history rather than passed
   * to git as given. Without that, any string reaching this method addresses any
   * object in the repository — and the repository holds every vault's notes,
   * which is precisely the tenant boundary the rest of the server spends its
   * time defending.
   *
   * A history that could not be read fails as itself rather than as a missing
   * version. The check above cannot be satisfied by a list nobody could
   * fetch, and answering "no such version" to a commit id the client got from
   * this very server is how a broken sidecar passes for a working one.
   */
  async contentAt(owner: string, notePath: string, versionId: string): Promise<string> {
    const notePathCanonical = normalizeVaultPath(notePath);
    const root = this.#root(owner);

    const known = await this.#versionsAt(owner, notePathCanonical);
    if (known.state === 'broken') throw new HistoryUnreadableError('the history could not be read');
    const wanted = known.versions.find((version) => version.id === versionId);
    if (wanted === undefined) {
      throw new NoteNotFoundError('no such version of this note');
    }

    // The name it had then, not the name it has now. Asking for today's path in
    // a commit from before a rename is answered "path does not exist in", which
    // this method would report as "the note did not exist at that version" — a
    // version the server had just listed as available.
    try {
      const { stdout } = await this.#run(root, ['show', `${versionId}:${wanted.pathAt}`], {
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const failure = await this.#classify(root, error);
      if (failure.kind === 'refused' && PATH_ABSENT_AT_COMMIT.test(failure.stderr)) {
        // The commit exists and touched this path, but the path is absent *at*
        // that commit — which is what a deletion looks like from here.
        throw new NoteNotFoundError('the note did not exist at that version');
      }
      throw this.#unreadable(owner, failure);
    }
  }
}
