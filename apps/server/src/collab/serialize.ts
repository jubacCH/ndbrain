import type * as Y from "yjs";

/**
 * Sets `ytext`'s content to exactly `markdown`.
 *
 * Idempotent: if `ytext` already reads as `markdown`, this is a true no-op
 * (no Yjs ops are applied at all). On an empty Y.Text it does a plain
 * insert. On a Y.Text with differing content it falls back to the same
 * minimal prefix/suffix replace used by `applyExternalChange`, so seeding
 * over an already-populated Y.Text doesn't blow away unrelated CRDT
 * history/cursors unnecessarily.
 */
export function seedYText(ytext: Y.Text, markdown: string): void {
  const current = ytext.toString();
  if (current === markdown) {
    return;
  }
  if (current.length === 0) {
    ytext.insert(0, markdown);
    return;
  }
  replaceDiff(ytext, current, markdown);
}

/** Reads the current markdown content of a Y.Text. */
export function readMarkdown(ytext: Y.Text): string {
  return ytext.toString();
}

/**
 * Rebases `ytext` onto `newMarkdown` (e.g. after an external, out-of-band
 * edit to the markdown file) by applying a minimal prefix/suffix
 * delete+insert within a single transaction, instead of blindly clearing
 * and reinserting the whole text.
 *
 * No-op if `ytext` already reads as `newMarkdown`.
 */
export function applyExternalChange(ydoc: Y.Doc, ytext: Y.Text, newMarkdown: string): void {
  const current = ytext.toString();
  if (current === newMarkdown) {
    return;
  }
  ydoc.transact(() => {
    replaceDiff(ytext, current, newMarkdown);
  });
}

/**
 * Simple, robust (deliberately NOT optimal) diff: finds the longest common
 * prefix and longest common suffix between `oldStr` and `newStr`, then
 * replaces only the differing middle segment via a single delete + insert
 * on `ytext`.
 *
 * This is not a minimal edit-distance/LCS diff (it won't detect e.g. a
 * reordered block as a move), but it's O(n), deterministic, and preserves
 * Yjs item identity for any unchanged prefix/suffix — which is what keeps
 * concurrent cursors and relative positions anchored there stable across
 * the rebase.
 */
function replaceDiff(ytext: Y.Text, oldStr: string, newStr: string): void {
  const maxCommon = Math.min(oldStr.length, newStr.length);

  let prefixLen = 0;
  while (prefixLen < maxCommon && oldStr[prefixLen] === newStr[prefixLen]) {
    prefixLen++;
  }

  // Bounded by `maxCommon - prefixLen` so prefix and suffix can never
  // overlap (prefixLen + suffixLen <= min(oldStr.length, newStr.length)),
  // even when both strings share long runs of repeated characters.
  let suffixLen = 0;
  const maxSuffix = maxCommon - prefixLen;
  while (
    suffixLen < maxSuffix &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const deleteCount = oldStr.length - prefixLen - suffixLen;
  const insertText = newStr.slice(prefixLen, newStr.length - suffixLen);

  if (deleteCount > 0) {
    ytext.delete(prefixLen, deleteCount);
  }
  if (insertText.length > 0) {
    ytext.insert(prefixLen, insertText);
  }
}
