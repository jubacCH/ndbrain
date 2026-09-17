/**
 * The file browser.
 *
 * A vault is a folder of files. Every other view in this application is about
 * the *notes* in it — the tree, search, the network — and until this existed
 * anything that was not a `.md` was invisible through the tool that owns the
 * folder, which also made it unremovable. A screenshot dropped next to a note
 * was a file only the filesystem knew about.
 *
 * So this view deliberately shows the vault as it actually is rather than as the
 * index sees it: real folders, real names, real byte sizes, attachments and
 * notes side by side. It is the one place where the answer to "what is in there"
 * comes from the disk instead of from the database.
 *
 * Folder-at-a-time rather than one long list. A flat listing of a few thousand
 * files is a search box with extra steps, and the point of a browser is that the
 * structure is what you navigate by.
 */

import { useMemo, useRef, useState } from 'react';
import { copy } from './copy';

import { api, type FileRow } from './api';
import { SpaceIcon } from './icons';
import { displayName } from './Tree';

/** A vault the browser can show: the caller's own, or a space they are a member of. */
export interface FilesVault {
  id: string;
  label: string;
  space: boolean;
}

export interface FilesProps {
  files: FileRow[];
  dirs: string[];
  truncated: boolean;
  owner: string;
  /** Every vault on offer, own first. The picker is shown only when there is more than one. */
  vaults?: readonly FilesVault[];
  onVault?: (owner: string) => void;
  /** Whether a file may be written at this path; defaults to yes, for the caller's own vault. */
  mayWrite?: (path: string) => boolean;
  /** Whether files may be added to this folder. */
  mayAddTo?: (dir: string) => boolean;
  busy: boolean;
  /** Where we are in the vault; `''` is the root. */
  dir: string;
  onDir: (dir: string) => void;
  onUpload: (files: File[], intoDir: string) => void;
  onReplace: (path: string, file: File) => void;
  onDelete: (file: FileRow) => void;
  onOpenNote: (path: string) => void;
}

/** Bytes as something a person reads, not as a number of bytes. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The extension, upper-cased, as a coarse "what is this" label. */
function kindOf(file: FileRow): string {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'file';
  return name.slice(dot + 1).toUpperCase();
}

const IMAGE_KINDS = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP']);

export function FilesView({
  files,
  dirs,
  truncated,
  owner,
  vaults = [],
  onVault,
  mayWrite = () => true,
  mayAddTo = () => true,
  busy,
  dir,
  onDir,
  onUpload,
  onReplace,
  onDelete,
  onOpenNote,
}: FilesProps): React.JSX.Element {
  const importRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** What sits directly in this folder — subfolders first, then files. */
  const here = useMemo(() => {
    const prefix = dir === '' ? '' : `${dir}/`;
    const depth = prefix === '' ? 0 : prefix.split('/').length - 1;

    const childDirs = dirs
      .filter((d) => d.startsWith(prefix) && d.split('/').length === depth + 1)
      .sort((a, b) => a.localeCompare(b));

    const childFiles = files
      .filter((f) => f.path.startsWith(prefix) && f.path.split('/').length === depth + 1)
      .sort((a, b) => a.path.localeCompare(b.path));

    return { childDirs, childFiles };
  }, [files, dirs, dir, ]);

  /** How much sits below a subfolder, so a closed folder still says something. */
  const countIn = (folder: string): number =>
    files.filter((f) => f.path.startsWith(`${folder}/`)).length;

  const crumbs = dir === '' ? [] : dir.split('/');

  const current = vaults.find((vault) => vault.id === owner);
  // Export zips the caller's own vault on the server, never a share.
  const own = vaults.length === 0 || vaults[0]?.id === owner;
  const addable = mayAddTo(dir);

  const drop = (event: React.DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    if (!addable) return;
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length > 0) onUpload(dropped, dir);
  };

  return (
    <div
      className="pane padded files"
      data-dragging={dragging}
      onDragOver={(event) => {
        event.preventDefault();
        if (addable) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <h2 className="h-big">{copy.files.title}</h2>
      <p className="h-sub">
        {copy.files.subtitle}{' '}
        {truncated && <strong>{copy.files.capped}</strong>}
      </p>

      {vaults.length > 1 && onVault !== undefined && (
        <label className="files-vault">
          <span>{copy.files.vaultPicker}</span>
          <select
            value={owner}
            onChange={(event) => {
              onDir('');
              onVault(event.target.value);
            }}
          >
            {vaults.map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.space ? copy.files.spaceOption(vault.label) : copy.files.ownVault}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="files-bar">
        <nav className="crumbs" aria-label={copy.files.folderLabel}>
          <button type="button" onClick={() => onDir('')} disabled={dir === ''}>
            {current?.space === true ? (
              <>
                <SpaceIcon size={13} /> {current.label}
              </>
            ) : (
              copy.files.vault
            )}
          </button>
          {crumbs.map((segment, i) => (
            <button
              key={crumbs.slice(0, i + 1).join('/')}
              type="button"
              onClick={() => onDir(crumbs.slice(0, i + 1).join('/'))}
              disabled={i === crumbs.length - 1}
            >
              <span aria-hidden>›</span> {displayName(segment)}
            </button>
          ))}
        </nav>

        <div className="files-actions">
          {addable && (
            <button type="button" onClick={() => importRef.current?.click()} disabled={busy}>
              {copy.files.import}
            </button>
          )}
          {/* An ordinary link, not a fetch: the browser saves the stream as it
              arrives instead of the page holding an entire vault in memory. */}
          {own && (
            <a className="btn" href={api.exportUrl()} download>
              {copy.files.downloadAll}
            </a>
          )}
        </div>
      </div>

      <input
        ref={importRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          if (picked.length > 0) onUpload(picked, dir);
          // Cleared so picking the same file twice in a row fires again.
          event.target.value = '';
        }}
      />
      <input
        ref={replaceRef}
        type="file"
        hidden
        onChange={(event) => {
          const picked = event.target.files?.[0];
          if (picked !== undefined && replacing !== null) onReplace(replacing, picked);
          setReplacing(null);
          event.target.value = '';
        }}
      />

      {here.childDirs.length === 0 && here.childFiles.length === 0 ? (
        <p className="empty">
          {copy.files.empty}
        </p>
      ) : (
        <table className="tbl files-tbl">
          <thead>
            <tr>
              <th>{copy.files.name}</th>
              <th>{copy.files.kind}</th>
              <th className="n">{copy.files.size}</th>
              <th className="n">{copy.files.actions}</th>
            </tr>
          </thead>
          <tbody>
            {here.childDirs.map((folder) => (
              <tr key={`d:${folder}`}>
                <td>
                  <button type="button" className="linky" onClick={() => onDir(folder)}>
                    <span aria-hidden>▸</span> {displayName(folder.slice(folder.lastIndexOf('/') + 1))}
                  </button>
                </td>
                <td className="dim">{copy.files.folderKind}</td>
                <td className="n dim">{copy.files.fileCount(countIn(folder))}</td>
                <td className="n" />
              </tr>
            ))}

            {here.childFiles.map((file) => {
              const name = file.path.slice(file.path.lastIndexOf('/') + 1);
              const kind = kindOf(file);
              return (
                <tr key={file.path}>
                  <td>
                    {file.isNote ? (
                      <button type="button" className="linky" onClick={() => onOpenNote(file.path)}>
                        {name}
                      </button>
                    ) : (
                      <span>{name}</span>
                    )}
                  </td>
                  <td className="dim">
                    <span className="pill p-tag">{kind}</span>
                    {IMAGE_KINDS.has(kind) && <span className="dim"> image</span>}
                  </td>
                  <td className="n">{humanSize(file.size)}</td>
                  <td className="n files-row-actions">
                    <a href={api.fileUrl(owner, file.path)} download={name}>
                      {copy.files.download}
                    </a>
                    {mayWrite(file.path) && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setReplacing(file.path);
                            replaceRef.current?.click();
                          }}
                          disabled={busy}
                        >
                          {copy.files.replace}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => onDelete(file)}
                          disabled={busy}
                        >
                          {copy.files.delete}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {dragging && <div className="files-drop">{copy.files.dropInto(dir === '' ? copy.files.theVault : dir)}</div>}
    </div>
  );
}
