/**
 * The editor's buffer: the text that has been typed and not yet written, and
 * everything that gets it onto the disk.
 *
 * This is the one part of the application with a hard promise behind it —
 * typed text does not go missing — and that promise is kept by several pieces
 * that only work together. The buffer holds at most one note's text; a debounce
 * turns a burst of typing into one write; writes run one after another so that
 * a read or a delete can wait for them; a write that failed puts its text back
 * and tries again; and every way out of the page asks the buffer whether it
 * still owes the server something.
 *
 * It lives here rather than in the shell because the shell is a screen and this
 * is a promise about data. Everything the promise rests on — `pending`, `owed`,
 * `held`, `versions`, the debounce timer, the unload handlers — is reachable
 * from one file, which is the only way any of it can be read as a whole.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError, refKey } from './api';
import { copy } from './copy';
import { invalidate } from './queries';

/** What the header says about the text in the editor. */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'failed';

/** Which note, as an identity rather than as content. */
export interface NoteRef {
  owner: string;
  path: string;
}

/** A note's text waiting to be written. */
interface Outstanding extends NoteRef {
  content: string;
}

/**
 * The write itself, as the shell's save mutation performs it.
 *
 * Described by its shape rather than taken from the mutation: this buffer needs
 * the version a write produced and the copy it displaced, and nothing else.
 */
type Save = (vars: {
  owner: string;
  path: string;
  content: string;
  baseMtimeMs?: number;
}) => Promise<{ note: { mtimeMs: number }; conflictCopy?: string | undefined }>;

/**
 * How long a failed write waits before trying again.
 *
 * Longer than any debounce, because the thing it is waiting for is not a pause
 * in typing but a server that was not there — and short enough that the text is
 * on disk before somebody who saw the warning has finished reading it.
 */
const SAVE_RETRY_MS = 2_000;

/** Everything the shell may do to the buffer, and everything it may ask it. */
export interface NoteBuffer {
  /** Which note is open — the identity, not its content. */
  openRef: NoteRef | null;
  /**
   * The open note as of this moment, not as of the last render.
   *
   * Read by code that resumes after a request — a save answering, a delete
   * answering — and must act on what is open *now*. A value captured in a
   * callback's closure is whatever was open when it started, which is how a
   * slow delete closed the note opened while it ran.
   */
  openNow: RefObject<NoteRef | null>;
  setOpenRef: (next: NoteRef | null) => void;
  saveState: SaveState;
  /** Notes being deleted right now, by `refKey` — the editor locks on these. */
  deletingKeys: ReadonlySet<string>;
  /** Whether any text is waiting to be written. */
  hasPending: () => boolean;
  /** Takes a keystroke: the text goes into the buffer and the debounce restarts. */
  scheduleSave: (owner: string, path: string, content: string) => void;
  /** Writes whatever is pending right now. */
  flush: () => Promise<void>;
  /** Writes what is pending and waits until no write is running any more. */
  settle: () => Promise<void>;
  /**
   * A note has just been read from the server and is now the one on screen:
   * the version it was read at is what its writes will claim as their base.
   */
  opened: (owner: string, path: string, mtimeMs: number) => void;
  /** Nothing is open any more, and nothing is owed on the screen. */
  closed: () => void;
  /** Nothing lives at this path now: forget the version it was read at. */
  forget: (owner: string, path: string) => void;
  /**
   * Drops the buffer without writing it.
   *
   * For the one case where the text on the server is the truth and this tab's
   * is not: a restored version has just replaced the file underneath the editor.
   */
  discard: () => void;
  /**
   * Takes a note out of reach of every writer while it is being deleted, and
   * moves its unsaved text to a slot of its own. Answers `false` when a delete
   * of that note is already running.
   */
  beginDelete: (owner: string, path: string) => boolean;
  /** Whether unsaved text of a note being deleted is waiting to be written. */
  holdsTextFor: (owner: string, path: string) => boolean;
  /** The note stays: release it, and write its unsaved text as it was held. */
  releaseDelete: (owner: string, path: string) => void;
  /** The note is gone: drop its held text and everything it was remembered by. */
  finishDelete: (owner: string, path: string) => void;
}

export function useNoteBuffer({
  save,
  saveDelayMs,
  onError,
}: {
  save: Save;
  /** How long a burst of typing is collected before it is written. */
  saveDelayMs: number;
  /** Where a write's complaint is said — a conflict copy, a failure, a 404. */
  onError: (message: string) => void;
}): NoteBuffer {
  const [openRef, setOpenRefState] = useState<NoteRef | null>(null);
  const openNow = useRef<NoteRef | null>(null);
  const setOpenRef = useCallback((next: NoteRef | null): void => {
    openNow.current = next;
    setOpenRefState(next);
  }, []);
  const [saveState, setSaveState] = useState<SaveState>('saved');

  /**
   * The write and the place complaints are said, reachable from callbacks that
   * must not be rebuilt.
   *
   * `write` is at the bottom of the chain that ends in the editor's change
   * handler and in the listeners registered once for `pagehide`; taking the
   * mutation itself as a dependency would tear all of that down and build it
   * again on every render.
   */
  const saveNote = useRef(save);
  saveNote.current = save;
  const complain = useRef(onError);
  complain.current = onError;
  /**
   * The debounce, likewise.
   *
   * `scheduleSave` runs on every keystroke and is handed to the editor once;
   * taking the delay as a dependency would tear down and rebuild the editor's
   * change handler every time a slider moved.
   */
  const delay = useRef(saveDelayMs);
  delay.current = saveDelayMs;

  const client = useQueryClient();

  const saveTimer = useRef<number | null>(null);
  const pending = useRef<Outstanding | null>(null);
  /**
   * The note whose text this tab still owes the server, by `refKey`, or null.
   *
   * Set when a write failed and its text was put back in `pending`, cleared
   * when that text finally lands. It is what keeps the failure on screen after
   * a switch to another note — opening one used to report "Saved" over it — and
   * what makes the browser ask before the tab is closed on top of it.
   */
  const owed = useRef<string | null>(null);
  /**
   * The version each note's text on this screen started from, by `refKey`, sent
   * with every write of that note.
   *
   * Kept in a ref rather than state because it has to be right at the moment the
   * debounce fires, not at the next render — and it is updated from each save's
   * response, so a run of autosaves does not report the first one's version and
   * make every later save look like a conflict.
   *
   * Per note, not one slot: a save answering after a switch used to write its
   * version into the slot of the note opened meanwhile, and that note's next
   * save then claimed a base it had never been read at.
   */
  const versions = useRef(new Map<string, number>());
  /**
   * The write in flight, if any. Writes run one after another, and opening or
   * deleting a note waits for them: a read that overtakes a running save shows
   * the text from before it, and a delete that overtakes one is undone by it.
   */
  const saving = useRef<Promise<void> | null>(null);
  /**
   * Unsaved text of notes being deleted, by `refKey` — see `deleting`. A slot of
   * its own per note, because `pending` has one and a note opened while the
   * question is open types into it.
   */
  const held = useRef(new Map<string, Outstanding>());
  /**
   * Notes being deleted right now, by `refKey`.
   *
   * From the moment the question is about to be asked until the delete has
   * answered, nothing writes to them: not the debounce, not a switch, not a tab
   * being hidden. Any of those used to be able to send a PUT that landed after
   * the DELETE and brought the note straight back. Their unsaved text waits in
   * `held` meanwhile — it is written after a cancel or a failed delete, and
   * dropped after a successful one. Mirrored in state so the editor can lock.
   * One delete per note at a time: a second request for a note already being
   * deleted returns at once.
   */
  const deleting = useRef(new Set<string>());
  const [deletingKeys, setDeletingKeys] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * Writes one note's text, after any write still running.
   *
   * The version sent is the note's own, read when the write actually goes out
   * — after the one before it has answered, so a run of saves chains each on
   * the version the previous one produced.
   */
  const write = useCallback(
    (outstanding: Outstanding): Promise<void> => {
      const key = refKey(outstanding.owner, outstanding.path);
      const previous = saving.current;
      const isOpen = (): boolean =>
        openNow.current?.owner === outstanding.owner && openNow.current.path === outstanding.path;

      const run = (async (): Promise<void> => {
        if (previous !== null) await previous;
        if (isOpen()) setSaveState('saving');
        try {
          const base = versions.current.get(key);
          // Through the mutation rather than `api.putNote` straight: what a
          // write does to the cache — this note's entry updated in place, and
          // exactly the queries an edit can have changed marked stale — belongs
          // with the other server state, not spelled out again in the shell.
          // Spread rather than `baseMtimeMs: base`, because a note being saved
          // for the first time has no version and `exactOptionalPropertyTypes`
          // separates "absent" from "present but undefined".
          const result = await saveNote.current({
            owner: outstanding.owner,
            path: outstanding.path,
            content: outstanding.content,
            ...(base === undefined ? {} : { baseMtimeMs: base }),
          });
          // This write is now the version to compare this note's next one against.
          versions.current.set(key, result.note.mtimeMs);
          // The debt is paid. Reported even when this note is no longer the one
          // on screen, because the warning it left there is about this text.
          const settled = owed.current === key;
          if (settled) owed.current = null;
          // Cleared only when nothing was typed while the write was in flight —
          // otherwise this would drop text newer than the version just stored.
          if (pending.current === null) window.__ndbrainPending = null;
          if (isOpen() || settled) setSaveState(pending.current === null ? 'saved' : 'dirty');

          // Somebody else's version was displaced and kept. Reported plainly and
          // left on screen: the text on this screen won, and the other one is only
          // recoverable if the person is told the file exists.
          if (result.conflictCopy !== undefined) {
            complain.current(copy.errors.conflict(result.conflictCopy));
          }
        } catch (caught) {
          if (isOpen()) setSaveState('failed');
          if (caught instanceof ApiError && caught.status === 404) {
            // The note is no longer at this path: renamed, moved or deleted
            // while this text was being typed. The server does not bring it
            // back into being at the old name (a save names its version), so
            // this text has nowhere to go — said plainly, and the tree
            // refreshed so the new name is there to paste it into. The text
            // stays in the editor, and in the crash box's slot: only a save
            // that succeeded ever clears that.
            complain.current(copy.errors.noteMovedWhileSaving);
            invalidate.afterStructure(client);
            return;
          }

          // The buffer was emptied before the request went out, so this text is
          // now nowhere but in the editor — and every way out of here (opening
          // another note, changing view, signing out, the tab being hidden)
          // asks `pending` whether there is anything to write. Put it back, and
          // try again on a timer: a server that was briefly not there is the
          // common case, and the alternative is a paragraph that quietly never
          // reaches the disk.
          //
          // Not when something newer is already waiting — that text is a later
          // version of this same document and includes it — and not into a note
          // being deleted, which is the one case where a write would bring a
          // file back from the dead. Not after a 401 either: the session is
          // over, every retry would fail the same way, and the text stays in
          // the crash box's slot where it was put on the keystroke.
          const sessionGone = caught instanceof ApiError && caught.status === 401;
          if (!sessionGone && pending.current === null && !deleting.current.has(key)) {
            pending.current = outstanding;
            window.__ndbrainPending = { path: outstanding.path, content: outstanding.content };
            owed.current = key;
            if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
            saveTimer.current = window.setTimeout(() => void flushLater.current?.(), SAVE_RETRY_MS);
            // Said whichever note is on screen. The indicator is one for the
            // whole window, and text owed to the server is worth more on it
            // than the state of the note that happens to be open.
            setSaveState('failed');
          }
          complain.current(caught instanceof ApiError ? caught.message : copy.errors.saveFailed);
        }
      })();

      saving.current = run;
      void run.finally(() => {
        if (saving.current === run) saving.current = null;
      });
      return run;
    },
    [client],
  );

  /**
   * `flush`, for the retry inside `write`.
   *
   * `flush` is built on `write`, so `write` cannot name it. The ref is the
   * knot in that circle, and it is assigned below as soon as `flush` exists.
   */
  const flushLater = useRef<(() => Promise<void>) | null>(null);

  /** Writes whatever is pending right now. */
  const flush = useCallback(async (): Promise<void> => {
    const outstanding = pending.current;
    if (outstanding === null) return;
    // Held, not written: see `deleting`.
    //
    // The second layer, not the only one. `scheduleSave` already keeps text
    // typed into a note being deleted out of `pending` entirely, so this check
    // is unreachable through the editor and stays anyway: `flush` is called
    // from a timer, from `pagehide` and from `visibilitychange`, and a delete
    // starting between such a call being queued and it running would otherwise
    // recreate the note from the text still sitting in `pending`. Removing it
    // leaves every test green — which says the hole is narrow, not that it is
    // closed.
    if (deleting.current.has(refKey(outstanding.owner, outstanding.path))) return;
    pending.current = null;
    await write(outstanding);
  }, [write]);
  flushLater.current = flush;

  /** Writes what is pending and waits until no write is running any more. */
  const settle = useCallback(async (): Promise<void> => {
    await flush();
    while (saving.current !== null) await saving.current;
  }, [flush]);

  const scheduleSave = useCallback(
    (owner: string, path: string, content: string): void => {
      // Typed into a note being deleted — possible only in the moment before
      // its editor locks: kept with that note's held text, never in `pending`.
      if (deleting.current.has(refKey(owner, path))) {
        held.current.set(refKey(owner, path), { owner, path, content });
        window.__ndbrainPending = { path, content };
        return;
      }
      pending.current = { owner, path, content };
      // Mirrored where the error boundary can still reach it: if a render fault
      // tears this tree down, the boundary is what hands the text back.
      window.__ndbrainPending = { path, content };
      setSaveState('dirty');
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), delay.current);
    },
    [flush],
  );

  // A retry must not outlive the screen it belongs to: a session that ended
  // mid-save would otherwise fire one into a shell that is no longer there.
  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  // A closing tab must not take the last sentence with it. The request itself
  // is sent with `keepalive`, so it survives the page it was started from.
  useEffect(() => {
    const onHide = (): void => {
      if (pending.current !== null) void flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flush]);

  /**
   * Asks before the window is closed on text that is not on disk.
   *
   * `pagehide` above starts the write, and `keepalive` lets it finish — but
   * neither can promise it arrived, and a note over the keepalive budget is
   * sent as an ordinary request that the browser will cancel. A save that
   * failed and is waiting for its retry has nothing on its side at all.
   *
   * The browser owns the wording; `preventDefault` is the whole of the API.
   * `returnValue` is set as well for the browsers that still want it.
   */
  useEffect(() => {
    const onLeaving = (event: BeforeUnloadEvent): void => {
      if (pending.current === null && owed.current === null) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeaving);
    return () => window.removeEventListener('beforeunload', onLeaving);
  }, []);

  const hasPending = useCallback((): boolean => pending.current !== null, []);

  const opened = useCallback(
    (owner: string, path: string, mtimeMs: number): void => {
      setOpenRef({ owner, path });
      versions.current.set(refKey(owner, path), mtimeMs);
      // Not unconditionally 'saved'. A write that failed left its text in the
      // buffer and its warning on screen, and opening another note used to
      // paint over both — the one moment at which somebody would close the tab
      // believing everything was on disk.
      setSaveState(owed.current === null ? 'saved' : 'failed');
    },
    [setOpenRef],
  );

  const closed = useCallback((): void => {
    setOpenRef(null);
    setSaveState('saved');
  }, [setOpenRef]);

  const forget = useCallback((owner: string, path: string): void => {
    versions.current.delete(refKey(owner, path));
  }, []);

  const discard = useCallback((): void => {
    pending.current = null;
    window.__ndbrainPending = null;
  }, []);

  const beginDelete = useCallback((owner: string, path: string): boolean => {
    const key = refKey(owner, path);
    // One delete of a note at a time. Checked and taken before anything is
    // awaited, so a double click or a second ⌘⌫ cannot start a second one —
    // whose cancel used to release the note while the first delete ran.
    if (deleting.current.has(key)) return false;
    deleting.current.add(key);
    setDeletingKeys(new Set(deleting.current));
    // Its unsaved text moves to a slot of its own, out of reach of a note
    // opened while the question is open.
    if (pending.current !== null && pending.current.owner === owner && pending.current.path === path) {
      held.current.set(key, pending.current);
      pending.current = null;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    return true;
  }, []);

  const holdsTextFor = useCallback(
    (owner: string, path: string): boolean => held.current.has(refKey(owner, path)),
    [],
  );

  const releaseDelete = useCallback(
    (owner: string, path: string): void => {
      const key = refKey(owner, path);
      deleting.current.delete(key);
      setDeletingKeys(new Set(deleting.current));
      const text = held.current.get(key);
      held.current.delete(key);
      if (text !== undefined) void write(text);
    },
    [write],
  );

  const finishDelete = useCallback((owner: string, path: string): void => {
    const key = refKey(owner, path);
    // Unsaved text in the deleted note is dropped, not written: a save landing
    // now would bring the note straight back.
    if (held.current.delete(key) && pending.current === null) window.__ndbrainPending = null;
    versions.current.delete(key);
    deleting.current.delete(key);
    setDeletingKeys(new Set(deleting.current));
  }, []);

  return {
    openRef,
    openNow,
    setOpenRef,
    saveState,
    deletingKeys,
    hasPending,
    scheduleSave,
    flush,
    settle,
    opened,
    closed,
    forget,
    discard,
    beginDelete,
    holdsTextFor,
    releaseDelete,
    finishDelete,
  };
}
