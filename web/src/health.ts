/**
 * Brain health: one calm number for how tidy the vault is, and where it comes from.
 *
 * The formula, in full:
 *
 *     share(c)  = min(1, findings(c) / notes)
 *     weight(c) = base(c) / sum of base over the findings that apply
 *     score     = round(100 × (1 − Σ weight(c) × share(c)))
 *
 * with base weights orphaned 0.3, broken links 0.3, untagged 0.2 and conflict
 * copies 0.2. Orphans and broken links weigh more because they are what breaks
 * finding things again; an untagged note is still reachable, and a conflict copy
 * is rare and loud already.
 *
 * Why relative to the note count: ten orphans in a vault of twenty is a
 * different state from ten in a vault of two thousand, and a raw count would
 * punish a large vault for being large. Why each share is capped at 1: broken
 * links are counted as links, and a vault can hold more of them than notes —
 * one category may take its whole weight, never more.
 *
 * "Untagged" applies only where tagging is a convention (see the server's
 * `Queries.tagsInUse`). Where it is not, the category is left out and the
 * remaining weights are scaled back up to 1, so a vault that files by folder is
 * not marked down for something it never meant to do.
 *
 * "Untouched" is deliberately not part of it. A note nobody has edited in a
 * year may be finished rather than neglected, and a score that falls simply
 * because time passes would be a streak by another name.
 *
 * The counts come from the caller's own vault only — the same findings the tidy
 * view lists — and so must the note count they are divided by.
 */

export type HealthKey = 'orphans' | 'broken' | 'untagged' | 'conflicts';

/** The base weights, before the ones that do not apply are left out. */
export const HEALTH_WEIGHTS: Readonly<Record<HealthKey, number>> = {
  orphans: 0.3,
  broken: 0.3,
  untagged: 0.2,
  conflicts: 0.2,
};

/** Order of the breakdown: what breaks finding things first. */
export const HEALTH_ORDER: readonly HealthKey[] = ['orphans', 'broken', 'untagged', 'conflicts'];

export interface HealthInput {
  /** Notes in the caller's own vault. */
  notes: number;
  orphans: number;
  /** Broken links — links, not notes. */
  broken: number;
  /** `null` where tagging is not a convention in this vault. */
  untagged: number | null;
  conflicts: number;
}

export interface HealthPart {
  key: HealthKey;
  count: number;
  /** `findings / notes`, capped at 1. */
  share: number;
  /** The weight after scaling over the applicable categories. */
  weight: number;
  /** Points this category takes off 100, unrounded. */
  cost: number;
}

export interface Health {
  /** 0–100, or `null` for an empty vault, which has nothing to be healthy about. */
  score: number | null;
  /** Only the categories that apply, in `HEALTH_ORDER`. */
  parts: HealthPart[];
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export function brainHealth(input: HealthInput): Health {
  const counts: Record<HealthKey, number | null> = {
    orphans: finite(input.orphans),
    broken: finite(input.broken),
    untagged: input.untagged === null ? null : finite(input.untagged),
    conflicts: finite(input.conflicts),
  };

  const applicable = HEALTH_ORDER.filter((key) => counts[key] !== null);
  const total = applicable.reduce((sum, key) => sum + HEALTH_WEIGHTS[key], 0);
  const notes = finite(input.notes);

  const parts = applicable.map((key): HealthPart => {
    const count = counts[key] ?? 0;
    const share = notes === 0 ? 0 : Math.min(1, count / notes);
    const weight = HEALTH_WEIGHTS[key] / total;
    return { key, count, share, weight, cost: 100 * weight * share };
  });

  if (notes === 0) return { score: null, parts };

  const lost = parts.reduce((sum, part) => sum + part.cost, 0);
  const score = Math.round(100 - lost);
  return { score: Math.max(0, Math.min(100, score)), parts };
}
