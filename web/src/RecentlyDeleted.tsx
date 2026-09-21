/**
 * Recently deleted: the way back for a deleted note, at the end of Tidy up.
 *
 * The server decides everything that matters here — which deleted notes the
 * caller may see at all (only where they could write the note back), and
 * whether a saved version exists. This view shows that answer and nothing
 * more: a row that cannot be restored says why, with the button there and
 * disabled rather than missing, so "why can I not get it back" has an answer
 * on the screen instead of a guess.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api, ApiError, refKey, type DeletedNote } from './api';
import { copy } from './copy';
import { ownerLabel, useOwners } from './owners';
import { invalidate, keys, useDeleted } from './queries';
import { ago } from './Views';

interface Outcome {
  message: string;
  owner: string;
  path: string;
}

export function RecentlyDeleted({
  self,
  onOpen,
}: {
  /** The signed-in account; a row from any other vault names the vault. */
  self: string;
  onOpen: (owner: string, path: string) => void;
}): React.JSX.Element {
  const query = useDeleted(true);
  const client = useQueryClient();
  const owners = useOwners();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async (row: DeletedNote): Promise<void> => {
    if (!window.confirm(copy.deleted.confirm(row.title))) return;
    const key = refKey(row.owner, row.path);
    setBusy(key);
    setError(null);
    setOutcome(null);
    try {
      const result = await api.restoreDeleted(row.owner, row.path);
      setOutcome({
        message: result.samePath
          ? copy.deleted.restored(row.title)
          : copy.deleted.restoredElsewhere(row.title, result.note.path),
        owner: row.owner,
        path: result.note.path,
      });
      invalidate.afterStructure(client);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : copy.deleted.restoreFailed);
      void client.invalidateQueries({ queryKey: keys.deleted });
    } finally {
      setBusy(null);
    }
  };

  const rows = query.data?.notes ?? [];

  return (
    <section className="deleted" aria-labelledby="deleted-title">
      <h3 id="deleted-title" className="h-big deleted-title">
        {copy.deleted.title}
      </h3>
      <p className="h-sub">{copy.deleted.hint}</p>

      {outcome !== null && (
        <p className="deleted-outcome" role="status">
          {outcome.message}{' '}
          <button type="button" className="btn" onClick={() => onOpen(outcome.owner, outcome.path)}>
            {copy.deleted.open}
          </button>
        </p>
      )}
      {error !== null && (
        <p className="warnline" role="alert">
          {error}
        </p>
      )}

      {query.isPending ? (
        <p className="h-sub">{copy.deleted.loading}</p>
      ) : query.isError ? (
        <p className="warnline" role="alert">
          {copy.deleted.failed}
        </p>
      ) : rows.length === 0 ? (
        <p className="h-sub">{copy.deleted.empty}</p>
      ) : (
        <div className="tablewrap">
          <div className="tablescroll">
            <table>
              <thead>
                <tr>
                  <th>{copy.deleted.note}</th>
                  <th>{copy.deleted.folder}</th>
                  <th>{copy.deleted.deleted}</th>
                  <th className="n">
                    <span className="sr-only">{copy.deleted.restore}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = refKey(row.owner, row.path);
                  const whyId = `deleted-why-${encodeURIComponent(key)}`;
                  const vault = row.owner === self ? '' : ownerLabel(owners, row.owner);
                  const folder = [vault, row.folder].filter((part) => part !== '').join(' · ') || '/';
                  const ready = row.restore === 'ready';
                  return (
                    <tr key={key} data-restore={row.restore}>
                      <td className="nm">{row.title}</td>
                      <td className="pth">{folder}</td>
                      <td>
                        {copy.deleted.by(ago(row.at), row.actor)}
                        {ready && row.savedAt !== null && (
                          <span className="deleted-saved"> · {copy.deleted.savedAt(ago(row.savedAt))}</span>
                        )}
                        {/* The reason sits in the wide column, where it can wrap;
                            beside the button it would run off the table. */}
                        {row.restore !== 'ready' && (
                          <span id={whyId} className="deleted-why">
                            {copy.deleted.why[row.restore]}
                          </span>
                        )}
                      </td>
                      <td className="n deleted-action">
                        <button
                          type="button"
                          className="btn"
                          disabled={!ready || busy !== null}
                          aria-label={copy.deleted.restoreNamed(row.title)}
                          aria-describedby={ready ? undefined : whyId}
                          onClick={() => void restore(row)}
                        >
                          {busy === key ? copy.deleted.restoring : copy.deleted.restore}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
