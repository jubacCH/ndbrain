/**
 * Reaching a region and a link without a mouse.
 *
 * Clicking a link is the briefing's "why is this connected?", and a thing you
 * can only do by pointing at a one-pixel curve is a thing half the ways of
 * working this app do not have. The canvas has been focusable all along and
 * knew two keys; this is the third way in, and it is arithmetic over the graph,
 * so it is settled here rather than inside a key handler.
 *
 * The shape it walks: with nothing picked the arrows go round the regions, and
 * with a note picked they go round that note's links and back to the note. So
 * every link is two steps from its note, and the note is never lost on the way.
 */

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { buildGraph } from '../src/brain/model';
import { NOTHING, linksOf, step } from '../src/brain/walk';

function vault(edges: Array<[string, string]>, notes = ['a', 'b', 'c', 'd']): ReturnType<typeof buildGraph> {
  const data: GraphData = {
    nodes: notes.map((name) => ({
      owner: 'jb',
      path: `${name}.md`,
      title: name,
      folder: '',
      links: edges.filter(([x, y]) => x === name || y === name).length,
      tags: [],
      updatedAt: 0,
    })),
    edges: edges.map(([from, to]) => ({ owner: 'jb', from: `${from}.md`, to: `${to}.md` })),
  };
  return buildGraph(data);
}

describe('walking the picture with the keyboard', () => {
  it('goes round the regions when nothing is picked, both ways, and wraps', () => {
    const graph = vault([['a', 'b']]);
    expect(step(NOTHING, 1, graph, 3)).toEqual({ kind: 'region', region: 0 });
    expect(step({ kind: 'region', region: 0 }, 1, graph, 3)).toEqual({ kind: 'region', region: 1 });
    expect(step({ kind: 'region', region: 2 }, 1, graph, 3)).toEqual({ kind: 'region', region: 0 });
    // Backwards from nothing lands on the last one, so one press reaches
    // either end of the ring.
    expect(step(NOTHING, -1, graph, 3)).toEqual({ kind: 'region', region: 2 });
    expect(step({ kind: 'region', region: 0 }, -1, graph, 3)).toEqual({ kind: 'region', region: 2 });
  });

  it('has nowhere to go in an arrangement with no regions', () => {
    const graph = vault([['a', 'b']]);
    // The neighbourhood panel beside an open note: no hemispheres, no cells.
    expect(step(NOTHING, 1, graph, 0)).toEqual(NOTHING);
    expect(step({ kind: 'region', region: 0 }, 1, graph, 0)).toEqual(NOTHING);
  });

  it('goes round a picked note’s links and comes back to the note', () => {
    const graph = vault([
      ['a', 'b'],
      ['a', 'c'],
      ['d', 'a'],
    ]);
    const a = graph.index.get('jb\u0000a.md')!;
    const links = linksOf(graph, a);
    expect(links).toHaveLength(3);

    let at = step({ kind: 'note', node: a }, 1, graph, 4);
    expect(at).toEqual({ kind: 'link', edge: links[0]!, from: a });
    at = step(at, 1, graph, 4);
    expect(at).toEqual({ kind: 'link', edge: links[1]!, from: a });
    at = step(at, 1, graph, 4);
    expect(at).toEqual({ kind: 'link', edge: links[2]!, from: a });
    // Past the last one is the note again, not the first region.
    at = step(at, 1, graph, 4);
    expect(at).toEqual({ kind: 'note', node: a });
    // And backwards from the note is the last link.
    expect(step(at, -1, graph, 4)).toEqual({ kind: 'link', edge: links[2]!, from: a });
  });

  it('stays on a note that is linked to nothing', () => {
    const graph = vault([['b', 'c']]);
    const a = graph.index.get('jb\u0000a.md')!;
    expect(step({ kind: 'note', node: a }, 1, graph, 4)).toEqual({ kind: 'note', node: a });
    expect(step({ kind: 'note', node: a }, -1, graph, 4)).toEqual({ kind: 'note', node: a });
  });

  it('stops once at a pair linked both ways', () => {
    // Two edges, one relation. Walking them both would show the same panel
    // twice and make the note look twice as connected as it is — the reason
    // `planEdges` draws a twin only once.
    const graph = vault([
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'c'],
    ]);
    const a = graph.index.get('jb\u0000a.md')!;
    expect(linksOf(graph, a)).toHaveLength(2);
    const first = step({ kind: 'note', node: a }, 1, graph, 4);
    const second = step(first, 1, graph, 4);
    const third = step(second, 1, graph, 4);
    expect(third).toEqual({ kind: 'note', node: a });
  });

  it('falls back to the note when the picked link is not one of its own', () => {
    // A stale selection, e.g. a refetch that removed the link. The anchor is
    // still a note, so walking carries on from it rather than going nowhere.
    const graph = vault([
      ['a', 'b'],
      ['a', 'c'],
    ]);
    const a = graph.index.get('jb\u0000a.md')!;
    const links = linksOf(graph, a);
    const stray = graph.edges.length + 5;
    expect(step({ kind: 'link', edge: stray, from: a }, 1, graph, 4)).toEqual({
      kind: 'link',
      edge: links[0]!,
      from: a,
    });
  });
});
