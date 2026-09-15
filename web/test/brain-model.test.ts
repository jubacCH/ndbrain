/**
 * The graph model and the render model.
 *
 * The two ends of the chain, both testable without a canvas — which was the
 * whole reason for cutting the view into layers. What is checked here is not
 * that the picture is pretty but that the numbers the renderer is handed are the
 * ones the old single-file version computed for itself, node for node.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GraphData } from '../src/api';
import { Activity } from '../src/brain/activity';
import { HOME } from '../src/brain/camera';
import { BrainLayout } from '../src/brain/layout';
import { buildGraph, nodeKey } from '../src/brain/model';
import { PULSE_COLOUR, SceneBuilder } from '../src/brain/scene';

const VAULT: GraphData = {
  nodes: [
    { owner: 'jb', path: '10_Projects/ndbrain.md', title: 'ndBrain', folder: '10_Projects', links: 9 },
    { owner: 'jb', path: '10_Projects/myai.md', title: 'MyAI', folder: '10_Projects', links: 3 },
    { owner: 'jb', path: '20_Areas/homelab.md', title: 'Homelab', folder: '20_Areas', links: 4 },
    { owner: 'jb', path: '20_Areas/lonely.md', title: 'Lonely', folder: '20_Areas', links: 0 },
  ],
  edges: [
    { owner: 'jb', from: '10_Projects/ndbrain.md', to: '20_Areas/homelab.md' },
    { owner: 'jb', from: '10_Projects/myai.md', to: '20_Areas/homelab.md' },
  ],
};

describe('the graph model', () => {
  it('resolves both ends of an edge and records it on each', () => {
    const g = buildGraph(VAULT);
    expect(g.edges).toHaveLength(2);
    const homelab = g.index.get(nodeKey('jb', '20_Areas/homelab.md'))!;
    expect(g.touching[homelab]).toHaveLength(2);
    expect(g.touching[g.index.get(nodeKey('jb', '20_Areas/lonely.md'))!]).toHaveLength(0);
  });

  it('drops an edge whose other end is not on screen', () => {
    // Exactly the neighbourhood panel's situation: it is handed a subgraph, and
    // half an edge has nowhere to draw to.
    const g = buildGraph({
      nodes: VAULT.nodes.slice(0, 1),
      edges: VAULT.edges,
    });
    expect(g.edges).toHaveLength(0);
  });

  it('drops a link from a note to itself', () => {
    const g = buildGraph({
      nodes: VAULT.nodes,
      edges: [{ owner: 'jb', from: '10_Projects/myai.md', to: '10_Projects/myai.md' }],
    });
    expect(g.edges).toHaveLength(0);
  });

  it('keeps the degree the server counted rather than the edges on screen', () => {
    // The panel shows a slice; "how connected is this note" is still a question
    // about the vault, not about the slice.
    const g = buildGraph({ nodes: VAULT.nodes, edges: [] });
    expect(g.nodes.map((n) => n.degree)).toEqual([9, 3, 4, 0]);
  });

  it('names the most connected note as the one label that is always on', () => {
    const g = buildGraph(VAULT);
    expect(g.nodes[g.hub]!.title).toBe('ndBrain');
    expect(buildGraph({ nodes: [], edges: [] }).hub).toBe(-1);
  });

  it('gives a folder a place, and neighbouring folders neighbouring places', () => {
    const g = buildGraph(VAULT);
    expect(g.nodes[0]!.lobe).toBe(g.nodes[1]!.lobe);
    expect(g.nodes[0]!.lobe).not.toBe(g.nodes[2]!.lobe);
  });

  it('derives depth and bend from the note, not from where it sits in the reply', () => {
    // The vault gains a note at the top of the list: with the old index-derived
    // seed every note after it changed depth, and the whole picture with it.
    const grown: GraphData = {
      nodes: [
        { owner: 'jb', path: '00_Inbox/new.md', title: 'New', folder: '00_Inbox', links: 0 },
        ...VAULT.nodes,
      ],
      edges: VAULT.edges,
    };
    const before = buildGraph(VAULT);
    const after = buildGraph(grown);
    for (const node of before.nodes) {
      expect(after.nodes[after.index.get(node.key)!]!.depth).toBe(node.depth);
    }
    expect(after.edges.map((e) => e.curve)).toEqual(before.edges.map((e) => e.curve));
  });

  it('reaches the api module for types only, so the schemas stay out of the brain', () => {
    // The simulation is meant to move into a worker. A runtime import of the api
    // module would carry zod and every server schema into it for the sake of
    // one key function; `import type` is erased and costs nothing. (The path
    // comes from the working directory because jsdom's `import.meta.url` is not
    // a file URL.)
    const dir = join(process.cwd(), 'src', 'brain');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      const runtime = source.match(/^import\s+(?!type\b)[^;]*from\s+'\.\.\/api';/gm) ?? [];
      expect(runtime, file).toEqual([]);
    }
  });

  it('keeps two vaults apart even when the paths are the same', () => {
    const g = buildGraph({
      nodes: [
        { owner: 'jb', path: 'note.md', title: 'Mine', folder: '', links: 0 },
        { owner: 'other', path: 'note.md', title: 'Theirs', folder: '', links: 0 },
      ],
      edges: [],
    });
    expect(g.index.size).toBe(2);
    expect(g.nodes[0]!.depth).not.toBe(g.nodes[1]!.depth);
  });
});

describe('the render model', () => {
  const build = (picked = -1): ReturnType<SceneBuilder['build']> => {
    const g = buildGraph(VAULT);
    const layout = new BrainLayout(g, 800, 500);
    const activity = new Activity(g);
    return new SceneBuilder(g).build(layout, activity, HOME, picked, 800, 500);
  };

  it('draws from the back forwards', () => {
    const g = buildGraph(VAULT);
    const depths = g.order.map((i) => g.nodes[i]!.depth);
    expect([...depths].sort((a, b) => a - b)).toEqual(depths);
  });

  it('dims a note nothing links to and brightens a hub', () => {
    const scene = build();
    const g = buildGraph(VAULT);
    const lonely = scene.nodes[g.index.get(nodeKey('jb', '20_Areas/lonely.md'))!]!;
    const hub = scene.nodes[g.hub]!;
    expect(lonely.alpha).toBeLessThan(hub.alpha);
    expect(hub.colour).toEqual([79, 216, 224]);
  });

  it('turns an access into the colour of what happened, then lets it cool', () => {
    const g = buildGraph(VAULT);
    const layout = new BrainLayout(g, 800, 500);
    const activity = new Activity(g);
    const builder = new SceneBuilder(g);
    const at = g.index.get(nodeKey('jb', '20_Areas/homelab.md'))!;

    activity.record([
      {
        at: 0,
        kind: 'write',
        what: 'edit_note',
        path: '20_Areas/homelab.md',
        who: 'jb',
        agent: true,
        owner: 'jb',
      },
    ]);
    const hot = builder.build(layout, activity, HOME, -1, 800, 500);
    expect(hot.nodes[at]!.colour).toEqual(PULSE_COLOUR.write);
    expect(hot.sparks.length).toBe(2);

    // Ten seconds of frames. The flash is gone in under one; the warmth behind
    // it takes more than ten, which is the difference the two are there to make.
    for (let i = 0; i < 640; i += 1) activity.advance();
    const cool = builder.build(layout, activity, HOME, -1, 800, 500);
    expect(cool.nodes[at]!.colour).not.toEqual(PULSE_COLOUR.write);
    expect(cool.sparks).toHaveLength(0);
  });

  it('sends a ring outward when the note has no tract to send anything along', () => {
    const g = buildGraph(VAULT);
    const activity = new Activity(g);
    activity.record([
      {
        at: 0,
        kind: 'read',
        what: 'get_note',
        path: '20_Areas/lonely.md',
        who: 'jb',
        agent: false,
        owner: 'jb',
      },
    ]);
    activity.advance();
    const scene = new SceneBuilder(g).build(
      new BrainLayout(g, 800, 500),
      activity,
      HOME,
      -1,
      800,
      500,
    );
    expect(scene.sparks.every((s) => s.ring)).toBe(true);
    // Two rings, staggered — the second starts behind zero and is not drawn yet.
    expect(scene.sparks).toHaveLength(1);
  });

  it('ignores an event about a note that is not on screen', () => {
    const g = buildGraph(VAULT);
    const activity = new Activity(g);
    activity.record([
      {
        at: 0,
        kind: 'read',
        what: 'get_note',
        path: '30_Resources/elsewhere.md',
        who: 'jb',
        agent: false,
        owner: 'jb',
      },
    ]);
    expect(activity.sparks).toHaveLength(0);
  });

  it('starts a travelling spark on the note it came from', () => {
    const g = buildGraph(VAULT);
    const layout = new BrainLayout(g, 800, 500);
    const activity = new Activity(g);
    const at = g.index.get(nodeKey('jb', '10_Projects/ndbrain.md'))!;
    activity.record([
      {
        at: 0,
        kind: 'read',
        what: 'get_note',
        path: '10_Projects/ndbrain.md',
        who: 'jb',
        agent: false,
        owner: 'jb',
      },
    ]);
    const scene = new SceneBuilder(g).build(layout, activity, HOME, -1, 800, 500);
    expect(scene.sparks).toHaveLength(1);
    expect(scene.sparks[0]!.x).toBeCloseTo(layout.x[at]!, 6);
    expect(scene.sparks[0]!.y).toBeCloseTo(layout.y[at]!, 6);
  });

  it('labels the hub, and adds the note that was clicked', () => {
    const g = buildGraph(VAULT);
    const plain = build();
    expect(plain.labels.map((l) => l.text)).toEqual(['ndBrain']);
    const picked = build(g.index.get(nodeKey('jb', '20_Areas/lonely.md'))!);
    expect(picked.labels.map((l) => l.text)).toEqual(['ndBrain', 'Lonely']);
  });

  it('never puts more than four names on the canvas', () => {
    const many: GraphData = {
      nodes: Array.from({ length: 20 }, (_, i) => ({
        owner: 'jb',
        path: `n${i}.md`,
        title: `Note ${i}`,
        folder: '',
        links: 1,
      })),
      edges: [],
    };
    const g = buildGraph(many);
    const activity = new Activity(g);
    activity.record(
      many.nodes.map((n) => ({
        at: 0,
        kind: 'read' as const,
        what: 'get_note',
        path: n.path,
        who: 'jb',
        agent: false,
        owner: 'jb',
      })),
    );
    const scene = new SceneBuilder(g).build(
      new BrainLayout(g, 800, 500),
      activity,
      HOME,
      -1,
      800,
      500,
    );
    expect(scene.labels).toHaveLength(4);
  });

  it('shortens a long title rather than letting it run off the canvas', () => {
    const g = buildGraph({
      nodes: [
        {
          owner: 'jb',
          path: 'long.md',
          title: 'A title far longer than anything that fits beside a node',
          folder: '',
          links: 1,
        },
      ],
      edges: [],
    });
    const scene = new SceneBuilder(g).build(
      new BrainLayout(g, 800, 500),
      new Activity(g),
      HOME,
      -1,
      800,
      500,
    );
    expect(scene.labels[0]!.text).toBe('A title far longer than a…');
  });
});
