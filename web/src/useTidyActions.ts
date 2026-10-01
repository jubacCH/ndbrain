/**
 * Everything the Tidy up view does, and the one flag that says it is busy.
 *
 * Third cut out of `Shell`. It started as the bulk bar alone and grew by one
 * measurement: `bulkBusy` was not the bulk bar's — `applyTopics` and
 * `removeEmptyFolder` set the same flag. It never meant "a bulk action is
 * running", it meant "this view is working", and three operations shared it.
 * Taking only the bulk half would have left a setter being passed back out.
 *
 * The selection is read by one view and changed in four places, three of which
 * were written inline in the JSX — a set being copied and filtered in the middle
 * of a render tree, where nothing could reach it to test it.
 *
 * `runBulk` asks before it acts, and the questions are the interesting part:
 *
 *  - a cancelled question has to leave the vault alone, including the one that
 *    offers a default folder
 *  - a tag of nothing but blanks is not the same as cancelling, but means the
 *    same thing here: without the trim it passes the null check, is trimmed away
 *    downstream, and reports success for a no-op
 *  - a delete says what it will break before it asks, which is what turns
 *    "delete 1 note?" into a sentence somebody can answer
 *
 * The folder and the tag are asked for by `BulkDialog` now, not by
 * `window.prompt`. A hook renders nothing, so the question is a piece of state
 * — `ask` — that the view turns into a dialog and answers through `answerBulk`.
 * What the prompts could not do: check that a tag will be read back as one, and
 * offer the folders the vault actually has instead of a default named `Archive`
 * whether or not it existed. The delete keeps its `window.confirm`: it asks a
 * yes-or-no question, takes no input, and already says what will be lost.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { ApiError, api } from './api';
import { copy } from './copy';
import type { BulkAsk } from './BulkDialog';
import { invalidate } from './queries';

export interface TidyActionsDeps {
  /**
   * The caller's own account.
   *
   * The only vault a bulk action can touch: the tidy view that feeds this
   * selection never lists anybody else's notes.
   */
  userId: string;
  /** Flushes a pending save before notes move or go. */
  settle: () => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshOverview: () => Promise<void>;
  setError: (message: string | null) => void;
}

export interface TidyActions {
  selection: Set<string>;
  /**
   * Any of the three operations is in flight.
   *
   * One flag for all of them on purpose: they all act on the same list, and two
   * at once would act on a list one of them has already changed.
   */
  busy: boolean;
  /** How many notes the last topic application wrote, or null before one. */
  topicsDone: number | null;
  /** Ticks or unticks one path. */
  toggle: (path: string) => void;
  /** Ticks all of these, or clears the selection when they are already all ticked. */
  toggleAll: (paths: string[]) => void;
  /**
   * Drops anything no longer on screen.
   *
   * Called when the view narrows: a path that has scrolled out of the findings
   * must not still be acted on by a button the person can see.
   */
  keepSelected: (paths: string[]) => void;
  runBulk: (action: 'move' | 'tag' | 'delete') => Promise<void>;
  /**
   * The question a move or a tag has put on screen, for the view to draw.
   *
   * A hook renders nothing, so the question lives here and the dialog lives in
   * the shell. `null` while nothing is being asked, which is nearly always.
   */
  ask: BulkAsk | null;
  /** The dialog's answer. Acts on the paths the question was asked about. */
  answerBulk: (extra: { tag?: string; dir?: string }) => Promise<void>;
  /** The dialog was closed. The vault is left alone. */
  cancelBulk: () => void;
  /** Writes the tags the server proposes for these notes. */
  applyTopics: (paths: string[]) => Promise<void>;
  /** Deletes a folder that has nothing in it, after asking. */
  removeEmptyFolder: (dir: string) => Promise<void>;
}

export function useTidyActions(deps: TidyActionsDeps): TidyActions {
  const { userId, settle, refreshTree, refreshOverview, setError } = deps;
  const client = useQueryClient();

  const [selection, setSelection] = useState<Set<string>>(new Set());
  /**
   * The question on screen, with the paths it was asked about.
   *
   * The paths are held here rather than read from the selection when the answer
   * comes back: the dialog is open across renders, and a selection that changed
   * underneath would move notes nobody asked about.
   */
  const [ask, setAsk] = useState<{ action: 'move' | 'tag'; paths: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [topicsDone, setTopicsDone] = useState<number | null>(null);

  const toggle = useCallback((path: string): void => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback((paths: string[]): void => {
    setSelection((current) => (current.size === paths.length ? new Set() : new Set(paths)));
  }, []);

  const keepSelected = useCallback((paths: string[]): void => {
    setSelection((current) => {
      const shown = new Set(paths);
      const kept = [...current].filter((path) => shown.has(path));
      // The same set when nothing was dropped, so a narrowing that changes
      // nothing does not re-render everything that reads the selection.
      return kept.length === current.size ? current : new Set(kept);
    });
  }, []);

  /**
   * The part after the question: the same for all three actions.
   *
   * Separated from `runBulk` because two of the three now answer their question
   * through a dialog, which means this runs on a later turn than the one that
   * asked — and the paths have to be the ones that were selected when the
   * question was put, not whatever is selected when it is answered.
   */
  const apply = useCallback(
    async (
      action: 'move' | 'tag' | 'delete',
      paths: string[],
      extra: { tag?: string; dir?: string },
    ): Promise<void> => {
      // Written first, like every other operation that moves or removes a note
      // under the editor: a save in flight belongs to the path it was typed at,
      // and one that lands after a move re-creates the note there.
      await settle();

      setBusy(true);
      try {
        const result = await api.bulk(userId, action, paths, extra);
        setSelection(new Set());
        await refreshTree();
        await refreshOverview();

        if (result.failed.length === 0) {
          setError(null);
        } else {
          setError(
            copy.errors.bulkPartly(
              result.ok.length,
              result.failed.map((entry) => entry.path),
              result.failed[0]?.reason ?? '',
            ),
          );
        }
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.bulkFailed);
      } finally {
        setBusy(false);
      }
    },
    [userId, settle, refreshTree, refreshOverview, setError],
  );

  /**
   * Starts a bulk action: asks, then acts.
   *
   * A delete asks here, because `window.confirm` is a yes-or-no question with
   * nothing to type into. A move and a tag put their question on screen and
   * come back through `answerBulk` — with the paths they were asked about, so a
   * selection that changes while the dialog is open changes nothing about what
   * was already asked.
   */
  const runBulk = useCallback(
    async (action: 'move' | 'tag' | 'delete'): Promise<void> => {
      const paths = [...selection];
      if (paths.length === 0) return;

      if (action !== 'delete') {
        setAsk({ action, paths });
        return;
      }

      const preview = await api.deletePreview(userId, paths).catch(() => null);
      const afterwards = copy.ask.afterDelete(preview);
      if (!window.confirm(copy.ask.deleteNotes(paths.length) + (afterwards !== '' ? ` ${afterwards}` : ''))) return;

      await apply('delete', paths, {});
    },
    [selection, userId, apply],
  );

  /** The dialog's answer. Nothing happens if it is answered twice. */
  const answerBulk = useCallback(
    async (extra: { tag?: string; dir?: string }): Promise<void> => {
      const pending = ask;
      if (pending === null) return;
      setAsk(null);
      await apply(pending.action, pending.paths, extra);
    },
    [ask, apply],
  );

  const cancelBulk = useCallback((): void => setAsk(null), []);

  const applyTopics = useCallback(
    async (paths: string[]): Promise<void> => {
      setBusy(true);
      try {
        const { applied } = await api.applyTopics(paths);
        // Everything that reads tags is now stale: the tree markers, the tag
        // cloud, the untagged finding and the proposal list itself.
        invalidate.afterStructure(client);
        setTopicsDone(applied.length);
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.topics.failed);
      } finally {
        setBusy(false);
      }
    },
    [client, setError],
  );

  const removeEmptyFolder = useCallback(
    async (dir: string): Promise<void> => {
      if (!window.confirm(copy.ask.deleteFolder(dir))) return;

      setBusy(true);
      try {
        await api.deleteFolder(dir);
        // The tree shows folders off the filesystem, and the finding comes from
        // the same walk — both are stale the moment one goes.
        invalidate.afterStructure(client);
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.deleteFolderFailed);
      } finally {
        setBusy(false);
      }
    },
    [client, setError],
  );

  return {
    selection,
    busy,
    topicsDone,
    toggle,
    toggleAll,
    keepSelected,
    runBulk,
    // What is being asked, for the view to render; null while nothing is.
    ask: ask === null ? null : { kind: ask.action, count: ask.paths.length },
    answerBulk,
    cancelBulk,
    applyTopics,
    removeEmptyFolder,
  };
}
