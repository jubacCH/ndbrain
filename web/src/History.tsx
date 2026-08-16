/**
 * The version history of one note.
 *
 * The sidecar repository has been recording every vault every two minutes for
 * weeks, and until now the only way to reach any of it was a shell on the server.
 * That is the gap this closes: not "we keep history" — that was already true —
 * but "you can get it back".
 *
 * Two decisions worth keeping.
 *
 * **Nothing is restored without being read first.** Picking a version shows its
 * text; restoring is a second, deliberate action from inside that view. A list
 * of timestamps with a Restore button beside each is a list of chances to
 * overwrite today's work with a version nobody looked at.
 *
 * **A restore is a new edit, never a rewrite.** The version being replaced is
 * committed by the next tick like any other change, so undoing a restore is just
 * another restore. That is worth saying in the interface, because "restore" in
 * most tools means "lose everything after this point", and somebody hesitating
 * over that button deserves to know it does not mean that here.
 */

import { useState } from 'react';

import { api, type Version } from './api';
import { copy } from './copy';

export interface HistoryProps {
  owner: string;
  path: string;
  available: boolean;
  versions: Version[];
  canWrite: boolean;
  onRestored: () => void;
}

/** A date somebody can place without decoding it. */
function when(at: number, now = Date.now()): string {
  const date = new Date(at);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `${copy.history.today}, ${time}`;

  const yesterday = new Date(now - 86_400_000).toDateString() === date.toDateString();
  if (yesterday) return `${copy.history.yesterday}, ${time}`;

  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

export function HistoryPanel({
  owner,
  path,
  available,
  versions,
  canWrite,
  onRestored,
}: HistoryProps): React.JSX.Element {
  const [open, setOpen] = useState<Version | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = async (version: Version): Promise<void> => {
    setOpen(version);
    setContent(null);
    setError(null);
    try {
      setContent(await api.versionContent(owner, path, version.id));
    } catch {
      setError(copy.history.loadFailed);
    }
  };

  const restore = async (): Promise<void> => {
    if (open === null) return;
    if (!window.confirm(copy.history.confirmRestore(when(open.at)))) return;

    setBusy(true);
    try {
      await api.restoreVersion(owner, path, open.id);
      setOpen(null);
      setContent(null);
      onRestored();
    } catch {
      setError(copy.history.restoreFailed);
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <section className="hist">
        <h4>{copy.history.title}</h4>
        <p className="empty">{copy.history.noSidecar}</p>
      </section>
    );
  }

  if (open !== null) {
    return (
      <section className="hist">
        <h4>
          <button type="button" className="linky" onClick={() => setOpen(null)}>
            <span aria-hidden>‹</span> {copy.history.title}
          </button>
        </h4>
        <p className="histwhen">{when(open.at)}</p>

        {error !== null && <p className="setbad">{error}</p>}
        {content === null && error === null && <p className="empty">{copy.history.loading}</p>}
        {content !== null && <pre className="histtext">{content}</pre>}

        {canWrite && content !== null && (
          <>
            <p className="setnote">{copy.history.restoreIsAnEdit}</p>
            <button type="button" className="histrestore" disabled={busy} onClick={() => void restore()}>
              {copy.history.restore}
            </button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="hist">
      <h4>
        {copy.history.title} · {versions.length}
      </h4>
      {versions.length === 0 ? (
        <p className="empty">{copy.history.none}</p>
      ) : (
        <ul className="histlist">
          {versions.map((version) => (
            <li key={version.id}>
              <button type="button" onClick={() => void show(version)}>
                {when(version.at)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
