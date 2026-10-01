/**
 * Whose vault a note is in, and what to call it.
 *
 * Since spaces, an owner is not necessarily a person. A space is a vault nobody
 * signs in to — "Familie", "Verein" — and its account name is a folder name
 * nobody chose to read. So every place that used to print the owner's id asks
 * here instead.
 *
 * It used to answer differently for the two: a space by its display name, a
 * person by their account name, on the grounds that the account name was what
 * the sharing screens showed. That reasoning expired when the account id became
 * a random identifier — "a folder name nobody chose to read" is now true of
 * every owner, not only of a space. So everybody is called by their display
 * name, and the id is the fallback for an owner this client has never been told
 * about.
 *
 * Provided once by the shell from the tree reply. A component rendered without
 * the provider (a test, a view that predates spaces) gets an empty directory
 * and prints ids exactly as before.
 */

import { createContext, useContext } from 'react';

import type { OwnerInfo, OwnerKind } from './api';

export type OwnerDirectory = ReadonlyMap<string, OwnerInfo>;

const EMPTY: OwnerDirectory = new Map();

export const OwnersContext = createContext<OwnerDirectory>(EMPTY);

export function useOwners(): OwnerDirectory {
  return useContext(OwnersContext);
}

/** Built from the tree reply; an absent list is an empty directory. */
export function ownerDirectory(owners: readonly OwnerInfo[] | undefined): OwnerDirectory {
  return new Map((owners ?? []).map((owner) => [owner.id, owner]));
}

export function ownerKind(directory: OwnerDirectory, id: string): OwnerKind {
  return directory.get(id)?.kind ?? 'person';
}

/**
 * What to call an owner on screen.
 *
 * The display name, for a person as much as for a space. The id is what is left
 * when the directory has never heard of this owner — a share from an account
 * that has since gone, a component rendered without the provider — and showing
 * it is better than showing nothing, even though nobody chose it to be read.
 */
export function ownerLabel(directory: OwnerDirectory, id: string): string {
  const info = directory.get(id);
  return info !== undefined && info.displayName !== '' ? info.displayName : id;
}
