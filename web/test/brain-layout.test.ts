/**
 * The layout, and the spatial memory it is there to protect.
 *
 * The briefing's rule is that the brain must not look completely different after
 * every reload, because the point of a picture of a vault is that somebody
 * learns where things are in it. A force layout has no unique solution, so that
 * rule is a question of what it starts from and of what it is allowed to move —
 * which is what most of this file is about. The shape itself is measured in
 * `brain-form.test.ts`.
 *
 * No canvas anywhere: positions are numbers, and the simulation never asked for
 * a DOM, nor, any more, for the size of the window.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import type { Arrangement } from '../src/brain/layout';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph, nodeKey } from '../src/brain/model';
import { loadPositions, positionsKey, savePositions } from '../src/brain/positions';
import { paraVault } from './fixtures/para-vault';

function vault(count: number): GraphData {
  const nodes = Array.from({ length: count }, (_, i) => ({
    owner: 'jb',
    path: `${i % 2 === 0 ? '10_Projects' : '20_Areas'}/note-${i}.md`,
    title: `Note ${i}`,
    folder: i % 2 === 0 ? '10_Projects' : '20_Areas',
    links: i % 5,
  }));
  const edges = [];
  for (let i = 1; i < count; i += 1) {
    edges.push({ owner: 'jb', from: nodes[i]!.path, to: nodes[i - 1]!.path });
  }
  return { nodes, edges };
}

const laid = (
  data: GraphData,
  remembered?: ReturnType<BrainLayout['positions']>,
  arrangement: Arrangement = 'brain',
): BrainLayout => new BrainLayout(buildGraph(data), { arrangement, remembered });

const captured = (data: GraphData, target: string): GraphData => ({
  nodes: [...data.nodes, { owner: 'jb', path: '00_Inbox/captured.md', title: 'Captured', folder: '00_Inbox', links: 1 }],
  edges: [...data.edges, { owner: 'jb', from: '00_Inbox/captured.md', to: target }],
});

describe('a start that does not move', () => {
  it('puts a note in the same place whatever order the server listed it in', () => {
    const data = vault(24);
    const shuffled: GraphData = { nodes: [...data.nodes].reverse(), edges: [...data.edges].reverse() };
    for (const arrangement of ['brain', 'loose'] as const) {
      const a = laid(data, undefined, arrangement);
      const b = laid(shuffled, undefined, arrangement);
      for (let i = 0; i < a.graph.nodes.length; i += 1) {
        const j = b.graph.index.get(a.graph.nodes[i]!.key)!;
        expect(b.x[j]).toBe(a.x[i]);
        expect(b.y[j]).toBe(a.y[i]);
      }
    }
  });

  it('gives remembered positions priority over anything it would compute', () => {
    const before = laid(vault(24));
    before.settle();
    const remembered = before.positions();

    const after = laid(captured(vault(24), '10_Projects/note-0.md'), remembered);
    for (const [key, at] of remembered) {
      const i = after.graph.index.get(key)!;
      expect(after.x[i]).toBe(at.x);
      expect(after.y[i]).toBe(at.y);
    }
  });

  it('drops a new note beside what it links to, not across the brain', () => {
    const settled = laid(vault(24));
    settled.settle();
    const after = laid(captured(vault(24), '20_Areas/note-7.md'), settled.positions());
    const fresh = after.graph.index.get(nodeKey('jb', '00_Inbox/captured.md'))!;
    const anchor = after.graph.index.get(nodeKey('jb', '20_Areas/note-7.md'))!;
    const gap = Math.hypot(after.x[fresh]! - after.x[anchor]!, after.y[fresh]! - after.y[anchor]!);
    // About where the spring between them would hold it: close enough that
    // nothing is hauled across the picture, far enough that the repulsion does
    // not throw either of them.
    expect(gap).toBeCloseTo(40, 6);
  });

  it('pulls a stored position that is finite but absurd back near the brain', () => {
    const absurd = new Map([[nodeKey('jb', '10_Projects/note-0.md'), { x: 1e308, y: -1e308 }]]);
    const layout = laid(vault(8), absurd);
    const { minX, minY, maxX, maxY } = layout.bounds;
    const i = layout.graph.index.get(nodeKey('jb', '10_Projects/note-0.md'))!;
    expect(layout.x[i]!).toBeLessThanOrEqual(maxX + (maxX - minX));
    expect(layout.y[i]!).toBeGreaterThanOrEqual(minY - (maxY - minY));
    layout.settle();
    expect(Number.isFinite(layout.x[i]!)).toBe(true);
  });

  it('ignores a stored position that is not a position', () => {
    const broken = new Map([[nodeKey('jb', '10_Projects/note-0.md'), { x: NaN, y: 3 }]]);
    const layout = laid(vault(4), broken);
    layout.settle();
    for (let i = 0; i < layout.x.length; i += 1) {
      expect(Number.isFinite(layout.x[i]!)).toBe(true);
      expect(Number.isFinite(layout.y[i]!)).toBe(true);
    }
  });

  it('never hands two notes the same starting point', () => {
    // Repulsion is computed from the vector between two nodes, so two nodes at
    // exactly the same point repel each other by zero in no direction and stay
    // there for ever. The seeding is what has to avoid it, including for two
    // notes created together against the same neighbour.
    const grown = vault(24);
    for (const name of ['first', 'second']) {
      grown.nodes.push({ owner: 'jb', path: `00_Inbox/${name}.md`, title: name, folder: '00_Inbox', links: 1 });
      grown.edges.push({ owner: 'jb', from: `00_Inbox/${name}.md`, to: '20_Areas/note-7.md' });
    }
    const layout = laid(grown, laid(vault(24)).positions());
    const seen = new Set<string>();
    for (let i = 0; i < layout.x.length; i += 1) {
      const at = `${layout.x[i]!},${layout.y[i]!}`;
      expect(seen.has(at)).toBe(false);
      seen.add(at);
    }
  });
});

describe('what may move', () => {
  it('lets everything move in a layout nobody has seen', () => {
    expect([...laid(vault(12)).mobile].every((m) => m === 1)).toBe(true);
  });

  it('lets only the new note and the note it links to move, not the other neighbours of that note', () => {
    const before = laid(vault(24));
    before.settle();
    const after = laid(captured(vault(24), '20_Areas/note-7.md'), before.positions());
    const moving = after.graph.nodes.filter((_, i) => after.mobile[i] === 1).map((n) => n.path).sort();
    // note-7 also links to note-6 and note-8 in the chain; they stay put. For a
    // hub with forty neighbours that is the difference between two notes moving
    // and forty-one.
    expect(moving).toEqual(['00_Inbox/captured.md', '20_Areas/note-7.md']);
  });

  it('notices a link between two notes that were both there before', () => {
    const before = laid(vault(24));
    before.settle();
    const linked = vault(24);
    linked.edges.push({ owner: 'jb', from: '10_Projects/note-2.md', to: '10_Projects/note-20.md' });
    const after = laid(linked, before.positions());
    const at = (path: string): number => after.mobile[after.graph.index.get(nodeKey('jb', path))!]!;
    expect(at('10_Projects/note-2.md')).toBe(1);
    expect(at('10_Projects/note-20.md')).toBe(1);
    expect(at('20_Areas/note-13.md')).toBe(0);
  });

  it('frees only the neighbours of a note that is picked up, and nothing once it has settled', () => {
    const before = laid(vault(24));
    before.settle();
    expect([...before.mobile].every((m) => m === 0)).toBe(true);
    const again = laid(vault(24), before.positions());
    again.hold(again.graph.index.get(nodeKey('jb', '10_Projects/note-4.md'))!);
    const free = again.graph.nodes.filter((_, i) => again.mobile[i] === 1).map((n) => n.path).sort();
    // The chain links note-4 to note-3 and note-5.
    expect(free).toEqual(['20_Areas/note-3.md', '20_Areas/note-5.md']);
    again.release();
    again.settle();
    expect([...again.mobile].every((m) => m === 0)).toBe(true);
  });
});

describe('the simulation', () => {
  it('knows nothing about a window', () => {
    // An own world: the constructor takes the graph and the arrangement, and
    // the result depends on nothing else. The camera test shows that a resize
    // changes only the mapping; the component test that a real resize leaves
    // the stored positions alone.
    const a = laid(vault(30));
    const b = laid(vault(30));
    a.settle();
    b.settle();
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
    expect(a.bounds.minX).toBeLessThan(0);
    expect(a.bounds.maxX).toBeGreaterThan(0);
  });

  it('grows the brain with the vault instead of crowding it', () => {
    const small = laid(vault(40));
    const large = laid(vault(160));
    // Four times the notes, twice the length: the same density.
    expect(large.unitLength / small.unitLength).toBeCloseTo(2, 9);
  });

  it('moves a held note only by hand, its neighbours towards it, and leaves it where it is dropped', () => {
    const layout = laid(vault(20));
    layout.settle();
    const neighbour = layout.graph.index.get(nodeKey('jb', '10_Projects/note-2.md'))!;
    const stranger = layout.graph.index.get(nodeKey('jb', '10_Projects/note-10.md'))!;
    const was = { n: layout.x[neighbour], s: layout.x[stranger], sy: layout.y[stranger] };
    layout.hold(3);
    layout.place(3, layout.x[3]! + 60, layout.y[3]! + 20);
    const dropped = { x: layout.x[3], y: layout.y[3] };
    for (let i = 0; i < 30; i += 1) layout.step();
    layout.release();
    layout.settle();
    expect(layout.x[3]).toBe(dropped.x);
    expect(layout.y[3]).toBe(dropped.y);
    expect(layout.x[neighbour]).not.toBe(was.n);
    expect(layout.x[stranger]).toBe(was.s);
    expect(layout.y[stranger]).toBe(was.sy);
  });

  it('keeps a dragged note on a leash near the brain', () => {
    const layout = laid(vault(6));
    layout.place(0, -50_000, 90_000);
    const { minX, minY, maxX, maxY } = layout.bounds;
    expect(layout.x[0]!).toBeGreaterThanOrEqual(minX - (maxX - minX));
    expect(layout.y[0]!).toBeLessThanOrEqual(maxY + (maxY - minY));
  });

  it('survives an empty vault and a single note', () => {
    for (const size of [0, 1]) {
      for (const arrangement of ['brain', 'loose'] as const) {
        const layout = laid(vault(size), undefined, arrangement);
        expect(() => layout.settle()).not.toThrow();
      }
    }
  });

  it('goes nowhere near a NaN, which would spread to every node it repels', () => {
    const layout = laid(vault(40));
    layout.settle();
    for (let i = 0; i < layout.x.length; i += 1) {
      expect(Number.isFinite(layout.x[i]!)).toBe(true);
      expect(Number.isFinite(layout.y[i]!)).toBe(true);
    }
  });
});

describe('remembering across sessions', () => {
  const mine = { account: 'julian', store: 'network' };
  beforeEach(() => window.localStorage.clear());

  it('comes back from storage close enough that nothing visibly moved', () => {
    const layout = laid(vault(12));
    layout.settle();
    savePositions(mine, layout.positions());

    const back = loadPositions(mine);
    for (const [key, at] of layout.positions()) {
      expect(back.get(key)!.x).toBeCloseTo(at.x, 1);
      expect(back.get(key)!.y).toBeCloseTo(at.y, 1);
      expect(back.get(key)!.links).toBe(at.links);
    }
  });

  it('keeps two accounts in the same browser apart', () => {
    // The first version kept one entry per view: whoever signed in last
    // overwrote the other's brain.
    savePositions({ account: 'julian', store: 'network' }, laid(vault(4)).positions());
    savePositions({ account: 'ramona', store: 'network' }, laid(vault(9)).positions());
    expect(loadPositions({ account: 'julian', store: 'network' }).size).toBe(4);
    expect(loadPositions({ account: 'ramona', store: 'network' }).size).toBe(9);
  });

  it('cannot be tricked into another account by a separator in the name', () => {
    expect(positionsKey({ account: 'a.b', store: 'c' })).not.toBe(positionsKey({ account: 'a', store: 'b.c' }));
    expect(positionsKey({ account: 'a/b', store: 'c' })).not.toBe(positionsKey({ account: 'a', store: 'b/c' }));
  });

  it('throws away positions from the old pixel format instead of reading them', () => {
    window.localStorage.setItem('ndbrain.brain.network', '{"jb\\u0000a.md":[512,384]}');
    window.localStorage.setItem('ndbrain.prefs', '{"theme":"dark"}');
    expect(loadPositions(mine).size).toBe(0);
    expect(window.localStorage.getItem('ndbrain.brain.network')).toBeNull();
    // Only the brain's own old entries.
    expect(window.localStorage.getItem('ndbrain.prefs')).not.toBeNull();
  });

  it('forgets notes that are gone rather than growing forever', () => {
    savePositions(mine, laid(vault(12)).positions());
    savePositions(mine, laid(vault(3)).positions());
    expect(loadPositions(mine).size).toBe(3);
  });

  it('keeps two views apart', () => {
    savePositions(mine, laid(vault(4)).positions());
    expect(loadPositions({ account: 'julian', store: 'other' }).size).toBe(0);
  });

  it('reads an empty arrangement rather than throwing on rubbish', () => {
    const key = positionsKey(mine);
    window.localStorage.setItem(key, 'not json');
    expect(loadPositions(mine).size).toBe(0);

    window.localStorage.setItem(key, '{"a":["left","up"]}');
    expect(loadPositions(mine).size).toBe(0);

    window.localStorage.setItem(key, '{"a":[1,2],"b":[3],"c":[4,5,-1]}');
    const back = loadPositions(mine);
    expect(back.size).toBe(2);
    // A position without a usable link hash still counts, as a changed note.
    expect(back.get('c')!.links).toBeUndefined();
  });

  it('holds still through the rounded store, and after a capture moves only the note linked to', () => {
    // The app never sees full precision: positions come back rounded to a
    // tenth. The claims of the layout have to hold on that path too — reloaded,
    // nothing moves; a capture onto the busiest note moves that note a little
    // and nothing else.
    const { data } = paraVault();
    const first = new BrainLayout(buildGraph(data), { arrangement: 'brain' });
    first.settle();
    savePositions(mine, first.positions());
    const stored = loadPositions(mine);

    const reloaded = new BrainLayout(buildGraph(data), { arrangement: 'brain', remembered: stored });
    expect(reloaded.settled).toBe(true);

    const hub = first.graph.nodes[first.graph.hub]!;
    for (const target of [hub, data.nodes[7]!]) {
      const path = `${target.folder}/zz captured.md`;
      const grown: GraphData = {
        nodes: [...data.nodes, { owner: 'jb', path, title: 'captured', folder: target.folder, links: 1 }],
        edges: [...data.edges, { owner: 'jb', from: path, to: target.path }],
      };
      const after = new BrainLayout(buildGraph(grown), { arrangement: 'brain', remembered: stored });
      after.settle();
      for (const [key, at] of stored) {
        const i = after.graph.index.get(key)!;
        const moved = Math.hypot(after.x[i]! - at.x, after.y[i]! - at.y);
        if (key === nodeKey('jb', target.path)) expect(moved).toBeLessThan(40);
        else expect(moved, key).toBe(0);
      }
    }
  });

  it('lets a note be dragged after a reload without moving anything but its neighbours', () => {
    const { data } = paraVault();
    const first = new BrainLayout(buildGraph(data), { arrangement: 'brain' });
    first.settle();
    savePositions(mine, first.positions());
    const stored = loadPositions(mine);
    const layout = new BrainLayout(buildGraph(data), { arrangement: 'brain', remembered: stored });

    const held = layout.graph.hub;
    const near = new Set(layout.graph.touching[held]!.flatMap((e) => [layout.graph.edges[e]!.a, layout.graph.edges[e]!.b]));
    layout.hold(held);
    layout.place(held, layout.x[held]! + 50, layout.y[held]! - 30);
    const dropped = { x: layout.x[held]!, y: layout.y[held]! };
    for (let t = 0; t < 20; t += 1) layout.step();
    layout.release();
    layout.settle();

    expect(layout.x[held]).toBe(dropped.x);
    expect(layout.y[held]).toBe(dropped.y);
    for (let i = 0; i < layout.x.length; i += 1) {
      if (near.has(i)) continue;
      const at = stored.get(layout.graph.nodes[i]!.key)!;
      expect(layout.x[i], layout.graph.nodes[i]!.key).toBe(at.x);
      expect(layout.y[i], layout.graph.nodes[i]!.key).toBe(at.y);
    }
  });

  it('declines to store a vault far past what this view is built for', () => {
    const huge = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < 20_001; i += 1) huge.set(`jb n${i}.md`, { x: i, y: i });
    savePositions(mine, huge);
    expect(window.localStorage.getItem(positionsKey(mine))).toBeNull();
  });
});
