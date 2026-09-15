/**
 * Stable pseudo-randomness, derived from a note's identity.
 *
 * Every arbitrary-looking number in this view — where a node starts, how far a
 * tract bends, how far back a cell body sits — used to come from the node's
 * position in the server's array. That made the picture a function of the reply
 * order: the graph endpoint sorts by path, so adding one note in `10_Projects`
 * shifted every index after it and the whole brain rearranged itself. The
 * vault's owner is supposed to build a spatial memory of this view, and a
 * picture that reshuffles on every capture cannot carry one.
 *
 * So the seed is the note's own key instead. Same note, same number, on any
 * machine, before and after a reload, whatever else the vault gained.
 */

/** FNV-1a, 32 bit. Small, no dependency, and well spread for short strings. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    // The classic FNV prime as shifts: `h * 16777619` overflows the 53-bit
    // mantissa and stops being the same function on large inputs.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/**
 * A number in [0, 1) for a key and a purpose.
 *
 * The purpose is part of the hash rather than a second call on the result,
 * because two draws for the same note must not be correlated: if the starting
 * angle and the depth came from the same number, every node far to the left
 * would also sit far back.
 */
export function unit(key: string, purpose: string): number {
  return hash32(`${purpose}:${key}`) / 0x1_0000_0000;
}
