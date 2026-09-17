/**
 * Whether the caller may change a note, as far as this screen can tell.
 *
 * Used to decide whether a destructive control is drawn at all, never whether a
 * write is attempted: the server decides that on every request, and a share
 * withdrawn a second ago still answers with a refusal. The rule is the server's
 * own (`ShareService.check`): your own vault always, somebody else's only under
 * a share that covers the path and carries write access.
 *
 * Where the note is open, the server's `canWrite` on the open note is the
 * better answer and is used instead; this is for places that only hold a path,
 * the tree and the inspector.
 */

import type { Share } from './api';

export function mayChange(self: string, received: readonly Share[], owner: string, path: string): boolean {
  if (owner === self) return true;
  return received.some(
    (share) => share.owner === owner && share.canWrite && (share.prefix === '' || path.startsWith(share.prefix)),
  );
}
