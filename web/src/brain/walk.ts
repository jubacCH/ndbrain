/**
 * What is picked in the brain, and how the arrow keys move it.
 *
 * Three things can be picked now: a note, one of its links, and a region. The
 * briefing asks for all three on a click (point 38), and a click is only half
 * of it — the canvas has been focusable since it was written, and a link is a
 * one-pixel curve, which is the hardest target in the whole app to point at.
 *
 * So the arrows walk a ring, and which ring depends on what is picked:
 *
 *  - nothing, or a region: the regions, in order, wrapping;
 *  - a note, or one of its links: the note and its links, in order, wrapping —
 *    so every link is one press from its note and the note is one press back.
 *
 * Kept here rather than in the key handler because it is arithmetic over the
 * graph and nothing else, which is the same reason `hit.ts` and `edgehit.ts`
 * are not in the component either.
 */

import type { BrainGraph } from './model';

/** What the picture has picked. Node and edge indices, as everywhere in here. */
export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'note'; readonly node: number }
  /** One link, and the note it was walked from — which is what the ring turns around. */
  | { readonly kind: 'link'; readonly edge: number; readonly from: number }
  | { readonly kind: 'region'; readonly region: number };

export const NOTHING: Selection = { kind: 'none' };

/** What a walk needs of the graph. */
type Walkable = Pick<BrainGraph, 'edges' | 'touching'>;

/**
 * The links of one note, one per distinct neighbour, in the graph's own order.
 *
 * A pair linked both ways has two edges and is one relation — the same rule
 * `planEdges` draws it by. Walking both would put the same panel on screen
 * twice in a row for no reason anybody pressing an arrow could see.
 */
export function linksOf(graph: Walkable, node: number): number[] {
  const touching = graph.touching[node];
  if (touching === undefined) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of touching) {
    const edge = graph.edges[i];
    if (edge === undefined) continue;
    const other = edge.a === node ? edge.b : edge.a;
    if (seen.has(other)) continue;
    seen.add(other);
    out.push(i);
  }
  return out;
}

/** Wraps `at` into `0 … size - 1`. */
function wrap(at: number, size: number): number {
  return ((at % size) + size) % size;
}

/**
 * One press of an arrow key.
 *
 * `dir` is 1 forwards and -1 back; `regions` is how many the arrangement has,
 * which is zero for the loose neighbourhood.
 */
export function step(current: Selection, dir: 1 | -1, graph: Walkable, regions: number): Selection {
  if (current.kind === 'none' || current.kind === 'region') {
    if (regions <= 0) return NOTHING;
    // From nothing, forwards is the first region and back is the last, so
    // either end of the ring is one press away.
    const at = current.kind === 'region' ? current.region : dir === 1 ? -1 : 0;
    return { kind: 'region', region: wrap(at + dir, regions) };
  }

  const from = current.kind === 'note' ? current.node : current.from;
  const links = linksOf(graph, from);
  if (links.length === 0) return { kind: 'note', node: from };

  // The ring is the note followed by its links, so 0 is the note itself. A
  // link that is not one of this note's any more — a refetch dropped it —
  // counts as standing on the note.
  const ring = links.length + 1;
  const held = current.kind === 'note' ? 0 : links.indexOf(current.edge) + 1;
  const next = wrap(Math.max(0, held) + dir, ring);
  return next === 0 ? { kind: 'note', node: from } : { kind: 'link', edge: links[next - 1]!, from };
}
