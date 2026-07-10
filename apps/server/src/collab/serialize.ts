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
  // Run the delete+insert inside a transaction so the transiently-deleted
  // middle state is never observable by other clients/observers. `.doc` is
  // only absent for a bare Y.Text not yet attached to a Y.Doc (a case the
  // signature explicitly allows); there's no transaction to join in that
  // case, so we fall back to calling replaceDiff directly.
  if (ytext.doc) {
    ytext.doc.transact(() => replaceDiff(ytext, current, markdown));
  } else {
    replaceDiff(ytext, current, markdown);
  }
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

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX;
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

  // Both `oldStr` and `newStr` are UTF-16 strings, so a code unit in
  // 0xD800-0xDBFF (high surrogate) followed by one in 0xDC00-0xDFFF (low
  // surrogate) is one surrogate pair (e.g. an emoji) and must never be cut
  // in half: doing so would make the CRDT delete/insert a lone surrogate,
  // splitting an item boundary mid-character (and, in this Yjs version,
  // corrupting the orphaned high surrogate into U+FFFD).
  //
  // The prefix boundary sits at index `prefixLen` in both strings, and
  // `oldStr[prefixLen - 1] === newStr[prefixLen - 1]` (that's what makes it
  // a common prefix), so it's enough to check the "before" side once
  // against `oldStr`; the "at the boundary" side is checked against both
  // strings since old/new can diverge exactly at that index.
  if (
    prefixLen > 0 &&
    isHighSurrogate(oldStr.charCodeAt(prefixLen - 1)) &&
    (isLowSurrogate(oldStr.charCodeAt(prefixLen)) || isLowSurrogate(newStr.charCodeAt(prefixLen)))
  ) {
    prefixLen--;
  }

  // Same idea for the suffix boundary: it sits at `oldStr.length -
  // suffixLen` / `newStr.length - suffixLen`, and the code unit AT that
  // boundary is guaranteed equal between old/new, so it's enough to check
  // it once; the "before" side (which is inside the differing region) can
  // diverge, so check both strings there.
  if (
    suffixLen > 0 &&
    isLowSurrogate(oldStr.charCodeAt(oldStr.length - suffixLen)) &&
    (isHighSurrogate(oldStr.charCodeAt(oldStr.length - suffixLen - 1)) ||
      isHighSurrogate(newStr.charCodeAt(newStr.length - suffixLen - 1)))
  ) {
    suffixLen--;
  }

  // Re-apply the overlap clamp after snapping (snapping only ever shrinks
  // prefixLen/suffixLen, so this is a defensive no-op in practice).
  if (prefixLen + suffixLen > maxCommon) {
    suffixLen = maxCommon - prefixLen;
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
