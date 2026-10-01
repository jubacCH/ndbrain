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
 * `window.prompt` for the folder and the tag is inherited, not chosen. The rest
 * of the shell has moved to real dialogs — starting a note did exactly this
 * until recently — and a prompt cannot validate a path, cannot say why one is
 * refused, and does not look like the application. It is left as it was because
 * replacing it is a change to the interface rather than to where this code
 * lives.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { ApiError, api } from './api';
import { copy } from './copy';
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
  /** Writes the tags the server proposes for these notes. */
  applyTopics: (paths: string[]) => Promise<void>;
  /** Deletes a folder that has nothing in it, after asking. */
  removeEmptyFolder: (dir: string) => Promise<void>;
}

export function useTidyActions(deps: TidyActionsDeps): TidyActions {
  const { userId, settle, refreshTree, refreshOverview, setError } = deps;
  const client = useQueryClient();

  const [selection, setSelection] = useState<Set<string>>(new Set());
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

  const runBulk = useCallback(
    async (action: 'move' | 'tag' | 'delete'): Promise<void> => {
      const paths = [...selection];
      if (paths.length === 0) return;

      let extra: { tag?: string; dir?: string } = {};

      if (action === 'move') {
        const dir = window.prompt(copy.ask.moveTo(paths.length), 'Archive');
        if (dir === null) return;
        extra = { dir };
      } else if (action === 'tag') {
        const tag = window.prompt(copy.ask.tagWith(paths.length));
        if (tag === null || tag.trim() === '') return;
        extra = { tag };
      } else {
        const preview = await api.deletePreview(userId, paths).catch(() => null);
        const afterwards = copy.ask.afterDelete(preview);
        if (!window.confirm(copy.ask.deleteNotes(paths.length) + (afterwards !== '' ? ` ${afterwards}` : ''))) return;
      }

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
    [selection, userId, settle, refreshTree, refreshOverview, setError],
  );

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

  return { selection, busy, topicsDone, toggle, toggleAll, keepSelected, runBulk, applyTopics, removeEmptyFolder };
}
