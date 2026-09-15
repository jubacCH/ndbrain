/**
 * The layout, and the spatial memory it is there to protect.
 *
 * The briefing's rule is that the brain must not look completely different after
 * every reload, because the point of a picture of a vault is that somebody
 * learns where things are in it. A force layout has no unique solution, so that
 * rule is entirely a question of what it starts from — which is what nearly all
 * of this file is about.
 *
 * No canvas anywhere: positions are numbers, and the simulation never asked for
 * a DOM. It only looked that way while it lived inside one.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph, nodeKey } from '../src/brain/model';
import { loadPositions, savePositions } from '../src/brain/positions';

const W = 900;
const H = 600;

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

const laid = (data: GraphData, remembered?: Map<string, { x: number; y: number }>): BrainLayout =>
  new BrainLayout(buildGraph(data), W, H, remembered);

describe('a start that does not move', () => {
  it('puts a note in the same place whatever order the server listed it in', () => {
    const data = vault(24);
    const shuffled: GraphData = { nodes: [...data.nodes].reverse(), edges: data.edges };

    const a = laid(data);
    const b = laid(shuffled);
    for (let i = 0; i < a.graph.nodes.length; i += 1) {
      const j = b.graph.index.get(a.graph.nodes[i]!.key)!;
      expect(b.x[j]).toBeCloseTo(a.x[i]!, 9);
      expect(b.y[j]).toBeCloseTo(a.y[i]!, 9);
    }
  });

  it('leaves the notes that were already there where they were', () => {
    // The whole of briefing point 47: capturing one note must not rearrange the
    // vault. Before, every position came from the array index, so inserting a
    // note near the front of an alphabetical listing moved everything after it.
    const before = laid(vault(24));
    const remembered = before.positions();

    const grown = vault(24);
    grown.nodes.unshift({
      owner: 'jb',
      path: '00_Inbox/captured.md',
      title: 'Captured',
      folder: '00_Inbox',
      links: 1,
    });
    grown.edges.push({ owner: 'jb', from: '00_Inbox/captured.md', to: '10_Projects/note-0.md' });

    const after = laid(grown, remembered);
    for (const [key, at] of remembered) {
      const i = after.graph.index.get(key)!;
      expect(after.x[i]).toBeCloseTo(at.x, 9);
      expect(after.y[i]).toBeCloseTo(at.y, 9);
    }
  });

  it('drops a new note beside what it links to, not across the canvas', () => {
    const base = vault(24);
    const settled = laid(base);
    for (let i = 0; i < 200; i += 1) settled.step();
    const remembered = settled.positions();

    const grown = vault(24);
    grown.nodes.push({
      owner: 'jb',
      path: '00_Inbox/captured.md',
      title: 'Captured',
      folder: '00_Inbox',
      links: 1,
    });
    grown.edges.push({ owner: 'jb', from: '00_Inbox/captured.md', to: '20_Areas/note-7.md' });

    const after = laid(grown, remembered);
    const fresh = after.graph.index.get(nodeKey('jb', '00_Inbox/captured.md'))!;
    const anchor = after.graph.index.get(nodeKey('jb', '20_Areas/note-7.md'))!;
    const gap = Math.hypot(after.x[fresh]! - after.x[anchor]!, after.y[fresh]! - after.y[anchor]!);
    // Close enough that the spring has nothing to haul across the picture, far
    // enough that the repulsion has a direction to work with.
    expect(gap).toBeCloseTo(18, 6);
  });

  it('takes a remembered position back into the window even when the window shrank', () => {
    const wide = laid(vault(8));
    for (let i = 0; i < 50; i += 1) wide.step();
    const narrow = new BrainLayout(buildGraph(vault(8)), 200, 150, wide.positions());
    for (let i = 0; i < narrow.x.length; i += 1) {
      expect(narrow.x[i]).toBeLessThanOrEqual(200);
      expect(narrow.y[i]).toBeLessThanOrEqual(150);
    }
  });

  it('ignores a stored position that is not a position', () => {
    const broken = new Map([[nodeKey('jb', '10_Projects/note-0.md'), { x: NaN, y: 3 }]]);
    const layout = laid(vault(4), broken);
    for (let i = 0; i < layout.x.length; i += 1) {
      expect(Number.isFinite(layout.x[i]!)).toBe(true);
      expect(Number.isFinite(layout.y[i]!)).toBe(true);
    }
  });
});

describe('the simulation', () => {
  it('settles inside the world it was given, which is what lets the camera start there', () => {
    const layout = laid(vault(60));
    for (let i = 0; i < 400; i += 1) layout.step();
    for (let i = 0; i < layout.x.length; i += 1) {
      expect(layout.x[i]!).toBeGreaterThanOrEqual(0);
      expect(layout.x[i]!).toBeLessThanOrEqual(W);
      expect(layout.y[i]!).toBeGreaterThanOrEqual(0);
      expect(layout.y[i]!).toBeLessThanOrEqual(H);
    }
  });

  it('never hands two notes the same starting point', () => {
    // Repulsion is computed from the vector between two nodes, so two nodes at
    // exactly the same point repel each other by zero in no direction and stay
    // there for ever. The simulation does not rescue that case and is not being
    // taught to here — the seeding is what has to avoid it, including for two
    // notes created together against the same neighbour.
    const grown = vault(24);
    for (const name of ['first', 'second']) {
      grown.nodes.push({
        owner: 'jb',
        path: `00_Inbox/${name}.md`,
        title: name,
        folder: '00_Inbox',
        links: 1,
      });
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

  it('holds a pinned note still while everything else keeps moving', () => {
    const layout = laid(vault(20));
    for (let i = 0; i < 60; i += 1) layout.step();
    layout.pinned = 3;
    layout.place(3, 300, 200);
    const other = layout.x[9];
    for (let i = 0; i < 30; i += 1) layout.step();
    expect(layout.vx[3]).toBe(0);
    expect(layout.vy[3]).toBe(0);
    expect(layout.x[9]).not.toBe(other);
  });

  it('keeps a dragged note inside the world', () => {
    const layout = laid(vault(6));
    layout.place(0, -5000, 9000);
    expect(layout.x[0]!).toBeGreaterThan(0);
    expect(layout.y[0]!).toBeLessThan(H);
  });

  it('survives an empty vault and a single note', () => {
    for (const size of [0, 1]) {
      const layout = laid(vault(size));
      expect(() => {
        for (let i = 0; i < 10; i += 1) layout.step();
      }).not.toThrow();
    }
  });

  it('goes nowhere near a NaN, which would spread to every node it repels', () => {
    const layout = laid(vault(40));
    for (let i = 0; i < 300; i += 1) layout.step();
    for (let i = 0; i < layout.x.length; i += 1) {
      expect(Number.isFinite(layout.x[i]!)).toBe(true);
      expect(Number.isFinite(layout.y[i]!)).toBe(true);
    }
  });

  it('lays out the same vault identically twice, run for run', () => {
    const a = laid(vault(30));
    const b = laid(vault(30));
    for (let i = 0; i < 150; i += 1) {
      a.step();
      b.step();
    }
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
  });
});

describe('remembering across sessions', () => {
  beforeEach(() => window.localStorage.clear());

  it('comes back from storage close enough that nothing visibly moved', () => {
    const layout = laid(vault(12));
    for (let i = 0; i < 100; i += 1) layout.step();
    savePositions('network', layout.positions());

    const back = loadPositions('network');
    for (const [key, at] of layout.positions()) {
      expect(back.get(key)!.x).toBeCloseTo(at.x, 1);
      expect(back.get(key)!.y).toBeCloseTo(at.y, 1);
    }
  });

  it('forgets notes that are gone rather than growing forever', () => {
    savePositions('network', laid(vault(12)).positions());
    savePositions('network', laid(vault(3)).positions());
    expect(loadPositions('network').size).toBe(3);
  });

  it('keeps two stores apart', () => {
    savePositions('network', laid(vault(4)).positions());
    expect(loadPositions('neighbourhood').size).toBe(0);
  });

  it('reads an empty arrangement rather than throwing on rubbish', () => {
    window.localStorage.setItem('ndbrain.brain.network', 'not json');
    expect(loadPositions('network').size).toBe(0);

    window.localStorage.setItem('ndbrain.brain.network', '{"jb a.md":["left","up"]}');
    expect(loadPositions('network').size).toBe(0);

    window.localStorage.setItem('ndbrain.brain.network', '{"jb a.md":[1,2],"jb b.md":[3]}');
    expect(loadPositions('network').size).toBe(1);
  });

  it('declines to store a vault far past what this view is built for', () => {
    const huge = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < 20_001; i += 1) huge.set(`jb n${i}.md`, { x: i, y: i });
    savePositions('network', huge);
    expect(window.localStorage.getItem('ndbrain.brain.network')).toBeNull();
  });
});
