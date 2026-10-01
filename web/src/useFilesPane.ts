/**
 * The file browser's own state, and the three writes it makes.
 *
 * Pulled out of `Shell` because none of it is anybody else's business: which
 * folder is on screen, whose vault is being browsed, and whether a transfer is
 * in flight are read by one view and written by one set of handlers. What stayed
 * behind in `Shell` was the opposite — `refreshTree`, `setError` and the open
 * note are shared by every view, so they come in as dependencies rather than
 * moving here.
 *
 * The handlers are the reason this is worth its own file. Each carries a
 * decision that is easy to lose in a rewrite:
 *
 *  - uploads run one at a time, because a vault import can be hundreds of files
 *  - a file that fails is named, because "could not import 1" of two hundred is
 *    not something anybody can act on
 *  - a delete waits for a pending save, because the file may be the open note
 *
 * `settle` before a delete is the subtle one. A file list holds notes, and the
 * file being removed can be the one in the editor with unsaved text. Flushing
 * first makes the delete the last word; without it a debounced save landing
 * afterwards writes the note back.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api, type FileRow } from './api';
import { copy } from './copy';
import { ownerLabel, type OwnerDirectory } from './owners';
import { keys, useFiles } from './queries';
import type { NoteRef } from './useNoteBuffer';

/** A vault the browser can be pointed at. */
export interface FileVault {
  id: string;
  label: string;
  space: boolean;
}

export interface FilesPaneDeps {
  /** The signed-in account, which is also the vault the browser starts in. */
  userId: string;
  /**
   * Whether the browser is on screen.
   *
   * The listing is the hook's own, not a parameter, because the owner it is
   * asked for lives here: passing the query in from outside would mean the
   * caller holding `filesOwner` as well, which is the state this file exists to
   * take away from it.
   */
  active: boolean;
  /** Which vaults are spaces and what they are called; from the tree reply. */
  owners: OwnerDirectory;
  /**
   * Whether the tree has answered yet.
   *
   * The reset below must not fire against an empty directory: before the first
   * reply every vault looks gone, and a browser pointed at a space would be
   * sent home on every reload.
   */
  treeReady: boolean;
  refreshTree: () => Promise<void>;
  setError: (message: string | null) => void;
  /** Flushes whatever the editor is holding, so a delete cannot be undone by it. */
  settle: () => Promise<void>;
  openRef: NoteRef | null;
  setOpenRef: (next: NoteRef | null) => void;
}

export interface FilesPane {
  /** The listing, so the caller can show its own trouble and empty states. */
  filesQuery: ReturnType<typeof useFiles>;
  filesDir: string;
  setFilesDir: (dir: string) => void;
  filesOwner: string;
  setFilesOwner: (owner: string) => void;
  filesBusy: boolean;
  filesVaults: FileVault[];
  refreshFiles: () => Promise<void>;
  uploadFiles: (picked: File[], intoDir: string) => Promise<void>;
  replaceFile: (path: string, file: File) => Promise<void>;
  removeFile: (file: FileRow) => Promise<void>;
}

export function useFilesPane(deps: FilesPaneDeps): FilesPane {
  const { userId, active, owners, treeReady, refreshTree, setError, settle, openRef, setOpenRef } = deps;
  const client = useQueryClient();

  const [filesDir, setFilesDir] = useState('');
  /** Whose files the browser shows: the caller's own vault, or a space's. */
  const [filesOwner, setFilesOwner] = useState(userId);
  const [filesBusy, setFilesBusy] = useState(false);

  // Own vault means no `owner` parameter at all, which is what the server reads
  // as "mine" — sending it explicitly would be a different request for the same
  // answer.
  const filesQuery = useFiles(active, filesOwner === userId ? undefined : filesOwner);

  /**
   * The vaults the file browser offers: the caller's own, then every space the
   * caller holds a membership in, by display name. A space that has gone (a
   * membership withdrawn, the space disabled) sends the browser back home.
   */
  const filesVaults = useMemo(
    () => [
      { id: userId, label: userId, space: false },
      ...[...owners.values()]
        .filter((owner) => owner.kind === 'space')
        .map((owner) => ({ id: owner.id, label: ownerLabel(owners, owner.id), space: true }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [owners, userId],
  );

  useEffect(() => {
    if (treeReady && !filesVaults.some((vault) => vault.id === filesOwner)) setFilesOwner(userId);
  }, [filesVaults, filesOwner, userId, treeReady]);

  const refreshFiles = useCallback(async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.files });
  }, [client]);

  /**
   * Sequential rather than parallel: a vault import can be hundreds of files,
   * and firing them all at once buys nothing on a single-user server while
   * making the failure of one indistinguishable from the failure of the rest.
   */
  const uploadFiles = useCallback(
    async (picked: File[], intoDir: string): Promise<void> => {
      setFilesBusy(true);
      const failed: string[] = [];
      try {
        for (const file of picked) {
          const target = intoDir === '' ? file.name : `${intoDir}/${file.name}`;
          try {
            await api.uploadFile(filesOwner, target, file);
          } catch (caught) {
            failed.push(`${file.name}: ${caught instanceof ApiError ? caught.message : 'failed'}`);
          }
        }
        await refreshFiles();
        // An uploaded note is a note: the tree and the index have to catch up.
        if (picked.some((file) => file.name.toLowerCase().endsWith('.md'))) await refreshTree();
        setError(failed.length === 0 ? null : copy.errors.importFailed(failed.length, failed[0] ?? ''));
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, filesOwner, setError],
  );

  const replaceFile = useCallback(
    async (path: string, file: File): Promise<void> => {
      setFilesBusy(true);
      try {
        await api.uploadFile(filesOwner, path, file);
        await refreshFiles();
        if (path.toLowerCase().endsWith('.md')) await refreshTree();
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.replaceFailed);
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, filesOwner, setError],
  );

  const removeFile = useCallback(
    async (file: FileRow): Promise<void> => {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (!window.confirm(copy.ask.deleteFile(name))) return;

      // A file list holds notes too, and the one being removed can be the one
      // open in the editor. Saving first means the delete is the last word.
      await settle();

      setFilesBusy(true);
      try {
        await api.deleteFile(filesOwner, file.path);
        await refreshFiles();
        if (file.isNote) {
          await refreshTree();
          // The open note may be the one just deleted.
          if (openRef !== null && openRef.owner === filesOwner && openRef.path === file.path) setOpenRef(null);
        }
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : copy.errors.deleteFileFailed);
      } finally {
        setFilesBusy(false);
      }
    },
    [refreshFiles, refreshTree, filesOwner, openRef, setOpenRef, setError, settle],
  );

  return {
    filesQuery,
    filesDir,
    setFilesDir,
    filesOwner,
    setFilesOwner,
    filesBusy,
    filesVaults,
    refreshFiles,
    uploadFiles,
    replaceFile,
    removeFile,
  };
}
