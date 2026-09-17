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
 * "Untagged" is a finding only where tagging is a convention (see the server's
 * `Queries.tagsInUse`), and the server already reports zero where it is not.
 * The weights are *not* rescaled in that case: the score must come out the same
 * whether or not the caller knows about the convention — the home view does,
 * the tidy view only approximates it — and a category that finds nothing costs
 * nothing either way. The part is still returned, marked `applies: false`, so a
 * view can say "not used" instead of "none".
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
  /** `null` where tagging is not a convention in this vault: counts as zero. */
  untagged: number | null;
  conflicts: number;
}

export interface HealthPart {
  key: HealthKey;
  count: number;
  /** `findings / notes`, capped at 1. */
  share: number;
  weight: number;
  /** False only for untagged, where tagging is not a convention. */
  applies: boolean;
  /** Points this category takes off 100, unrounded. */
  cost: number;
}

export interface Health {
  /** 0–100, or `null` for an empty vault, which has nothing to be healthy about. */
  score: number | null;
  /** Every category, in `HEALTH_ORDER`. */
  parts: HealthPart[];
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export function brainHealth(input: HealthInput): Health {
  const counts: Record<HealthKey, number> = {
    orphans: finite(input.orphans),
    broken: finite(input.broken),
    untagged: input.untagged === null ? 0 : finite(input.untagged),
    conflicts: finite(input.conflicts),
  };
  const notes = finite(input.notes);

  const parts = HEALTH_ORDER.map((key): HealthPart => {
    const count = counts[key];
    const share = notes === 0 ? 0 : Math.min(1, count / notes);
    const weight = HEALTH_WEIGHTS[key];
    return {
      key,
      count,
      share,
      weight,
      applies: !(key === 'untagged' && input.untagged === null),
      cost: 100 * weight * share,
    };
  });

  if (notes === 0) return { score: null, parts };

  const lost = parts.reduce((sum, part) => sum + part.cost, 0);
  return { score: Math.max(0, Math.min(100, Math.round(100 - lost))), parts };
}
