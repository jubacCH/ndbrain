/**
 * Whose vault a note is in, and what to call it.
 *
 * Since spaces, an owner is not necessarily a person. A space is a vault nobody
 * signs in to — "Familie", "Verein" — and its account name is a folder name
 * nobody chose to read. So every place that used to print the owner's id asks
 * here instead: a space is called by its display name and carries the space
 * icon, a person keeps the account name the sharing screens use.
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

/** A space by its display name, a person by account name. */
export function ownerLabel(directory: OwnerDirectory, id: string): string {
  const info = directory.get(id);
  return info !== undefined && info.kind === 'space' && info.displayName !== '' ? info.displayName : id;
}
