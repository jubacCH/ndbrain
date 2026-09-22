/**
 * What a view puts on screen when the answer never came.
 *
 * One component rather than a line in each view, because the failure it exists
 * to prevent is one every view makes independently: reading `query.data ?? []`
 * and then drawing the empty state over a request that failed. The sidebar told
 * somebody with ten thousand notes to start their first one; tidy up showed an
 * empty pane under a header that said "Loading…" for ever. Neither was wrong
 * about the data it had. Both were wrong about what having no data meant.
 *
 * Built on the pattern `RecentlyDeleted` already uses for a row that cannot be
 * restored: say it, say why, and leave the control there rather than removing
 * it. Here the control is "Try again", because a failed read is the one kind of
 * failure a person can genuinely do something about — and a message with no way
 * forward is just a nicer dead end.
 *
 * Deliberately `role="alert"` and not `role="status"`. A view that has nothing
 * in it is not an incidental update; somebody reading the screen through a
 * screen reader would otherwise be told nothing at all about why it is blank.
 */

import { copy } from './copy';
import type { Trouble as Kind } from './queries';

export function Trouble({
  kind,
  what,
  onRetry,
}: {
  kind: Kind;
  /** What could not be read, named — from `copy.trouble`, never a bare noun. */
  what: string;
  /**
   * Asks again. Offered even while offline: pressing it is how somebody says
   * "the connection is back now", and a request that is still impossible is
   * paused rather than failed, which costs nothing.
   */
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <p className="warnline trouble" role="alert">
      <span className="trouble-said">
        {kind === 'offline' ? copy.trouble.offline(what) : `${copy.trouble.failed(what)} ${copy.errors.serverQuiet}`}
      </span>
      <button type="button" className="btn" onClick={onRetry}>
        {copy.trouble.retry}
      </button>
    </p>
  );
}

/**
 * The connection, said once for the whole window.
 *
 * A per-view message answers "why is this empty"; this answers "why is
 * everything strange", which is the question somebody has while the calendar
 * still draws happily from the cache beside a task list that will never load.
 * The second sentence is the honest part: nothing is kept on this device, which
 * is exactly why there is never stale note text here and exactly why there is
 * nothing to show now.
 */
export function OfflineBar(): React.JSX.Element {
  return (
    <div className="offlinebar" role="status">
      <strong>{copy.trouble.offlineBanner}</strong> <span>{copy.trouble.offlineBannerWhy}</span>
    </div>
  );
}
