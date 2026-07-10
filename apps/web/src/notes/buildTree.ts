/** Pure transform from the flat `{path, title}` list the server returns into a
 *  nested folder tree for `NoteTree` to render. Kept dependency-free so it can be
 *  unit tested without touching React or the network. */

import type { NoteSummary } from "../api/client";

export interface TreeFile {
  type: "file";
  /** Full vault-relative path, e.g. "projects/ndbrain.md" — used as the React key
   *  and as the value handed to `setSelectedPath`. */
  path: string;
  /** Last path segment (the filename), e.g. "ndbrain.md". */
  name: string;
  title: string | null;
}

export interface TreeFolder {
  type: "folder";
  /** Folder path relative to the vault root, e.g. "projects" or "projects/archive". */
  path: string;
  /** Last path segment (the folder's own name), e.g. "archive". */
  name: string;
  children: TreeNode[];
}

export type TreeNode = TreeFolder | TreeFile;

/** Builds a nested tree from a flat note list, splitting each `path` on "/".
 *  Sorting rule (applied at every level, recursively): folders before files,
 *  then alphabetical (case-insensitive) by name within each group. */
export function buildTree(notes: NoteSummary[]): TreeNode[] {
  const root: TreeFolder = { type: "folder", path: "", name: "", children: [] };
  const folders = new Map<string, TreeFolder>([["", root]]);

  function getFolder(path: string): TreeFolder {
    const existing = folders.get(path);
    if (existing) return existing;

    const lastSlash = path.lastIndexOf("/");
    const parentPath = lastSlash === -1 ? "" : path.slice(0, lastSlash);
    const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);
    const parent = getFolder(parentPath);

    const folder: TreeFolder = { type: "folder", path, name, children: [] };
    parent.children.push(folder);
    folders.set(path, folder);
    return folder;
  }

  for (const note of notes) {
    const segments = note.path.split("/");
    const fileName = segments[segments.length - 1];
    const folderPath = segments.slice(0, -1).join("/");
    const folder = getFolder(folderPath);
    folder.children.push({ type: "file", path: note.path, name: fileName, title: note.title });
  }

  sortChildren(root);
  return root.children;
}

function sortChildren(folder: TreeFolder): void {
  for (const child of folder.children) {
    if (child.type === "folder") sortChildren(child);
  }
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
