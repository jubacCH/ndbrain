/**
 * What the vault is doing right now.
 *
 * The pulse endpoint reports every read and write, by a person or an agent, and
 * this turns that stream into the only thing in the view that is not structure:
 * a flash where it happened, a spark travelling each tract out of it, and a slow
 * warmth left behind. It is why the view is worth leaving open.
 *
 * Kept apart from both the graph and the layout because it is the one part with
 * a clock. The graph changes when the vault does, positions change when the
 * simulation runs, and this changes on its own, frame by frame, whether or not
 * anything else moved.
 *
 * Node indices, never node objects: a reply that arrives while the graph is
 * being rebuilt would otherwise leave sparks pointing at nodes nobody draws.
 */

import type { BrainGraph } from './model';
import { nodeKey } from './model';
import type { PulseEvent } from '../api';

export type PulseKind = 'read' | 'write';

export interface Spark {
  /** Edge index for a travelling spark, or -1 for the ring around a lone note. */
  edge: number;
  /** Which end it started at — the node index, for both kinds. */
  from: number;
  /** 0 to 1 along the tract. Starts negative for the second ring, to stagger it. */
  t: number;
  kind: PulseKind;
}

export class Activity {
  /** The short bright flash on access, by node index. */
  readonly fire: Float64Array;
  /** Slowly fading warmth — shows where work happened last. */
  readonly warm: Float64Array;
  /** Which colour the flash and the warmth carry, by node index. */
  readonly kind: Array<PulseKind>;
  sparks: Spark[] = [];

  #graph: BrainGraph;

  constructor(graph: BrainGraph) {
    this.#graph = graph;
    this.fire = new Float64Array(graph.nodes.length);
    this.warm = new Float64Array(graph.nodes.length);
    this.kind = graph.nodes.map(() => 'read' as PulseKind);
  }

  /** Events the poller has not shown yet. Ones about notes not on screen are dropped. */
  record(events: readonly PulseEvent[]): void {
    for (const ev of events) {
      if (ev.path === null) continue;
      const at = this.#graph.index.get(nodeKey(ev.owner, ev.path));
      if (at === undefined) continue;

      this.fire[at] = 1;
      this.warm[at] = 1;
      this.kind[at] = ev.kind;

      const touching = this.#graph.touching[at]!;
      for (const e of touching) {
        this.sparks.push({ edge: e, from: at, t: 0, kind: ev.kind });
      }
      // With no tract there would be nothing to show — so a ring runs outward
      // instead, or an event on an unconnected note would look like a fault.
      if (touching.length === 0) {
        this.sparks.push({ edge: -1, from: at, t: 0, kind: ev.kind });
        this.sparks.push({ edge: -1, from: at, t: -0.22, kind: ev.kind });
      }
    }
  }

  /** One frame of decay. Nothing here depends on where the nodes are. */
  advance(): void {
    for (const s of this.sparks) s.t += s.edge === -1 ? 0.028 : 0.02;
    this.sparks = this.sparks.filter((s) => s.t < 1);

    for (let i = 0; i < this.fire.length; i += 1) {
      const f = this.fire[i]!;
      if (f > 0) this.fire[i] = Math.max(0, f - 0.012);
      // Far slower than the flash: the warmth is this view's memory,
      // not its blinking.
      const w = this.warm[i]!;
      if (w > 0) this.warm[i] = Math.max(0, w - 0.0016);
    }
  }
}
