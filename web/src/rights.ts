/**
 * What the caller may do to a note, as far as this screen can tell.
 *
 * Used to decide whether a control is drawn at all, never whether a request is
 * attempted: the server decides that on every request, and a share withdrawn a
 * second ago still answers with a refusal. The rule is the server's own
 * (`ShareService.check`): your own vault always, somebody else's only under a
 * share that covers the path — and for a write, one that carries write access.
 *
 * Where the note is open, the server's `canWrite` on the open note is the
 * better answer and is used instead; this is for places that only hold a path,
 * the tree and the inspector.
 */

import type { OwnerKind, Share, User } from './api';

/**
 * Whether one share reaches one path in its owner's vault.
 *
 * The single place the scope rule lives on this side, as `withinScope` is on
 * the server. A note share is exact: it names one file, and `Plan.md.bak`,
 * `Plan2.md` or `Plan.md/x` are other files, however their names begin. A
 * folder's prefix ends in `/`, so a plain `startsWith` already stops at the
 * folder boundary; the vault's prefix is empty and covers everything.
 */
export function covers(share: Pick<Share, 'kind' | 'prefix'>, path: string): boolean {
  if (share.kind === 'note') return path === share.prefix;
  return share.prefix === '' || path.startsWith(share.prefix);
}

/** Whether the caller can see this note at all. */
export function mayRead(self: string, received: readonly Share[], owner: string, path: string): boolean {
  if (owner === self) return true;
  return received.some((share) => share.owner === owner && covers(share, path));
}

/** Whether the caller may write, create, rename or delete at this path. */
export function mayChange(self: string, received: readonly Share[], owner: string, path: string): boolean {
  if (owner === self) return true;
  return received.some((share) => share.owner === owner && share.canWrite && covers(share, path));
}

/**
 * Whether the caller may hand this note on to somebody else.
 *
 * Your own notes, always. A held share is never yours to pass on, write access
 * or not. In a space, nobody owns the notes, so the administrator does the
 * sharing — through the space's member list, not the caller's own shares.
 */
export function mayShare(user: Pick<User, 'id' | 'role'>, owner: string, ownerKind: OwnerKind): boolean {
  if (owner === user.id) return true;
  return ownerKind === 'space' && user.role === 'admin';
}
