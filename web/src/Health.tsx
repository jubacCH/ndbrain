/**
 * Brain health, drawn twice: a compact card on the home view and the head of
 * the tidy view.
 *
 * Both draw the same `brainHealth` result from the same own-vault findings, so
 * the two numbers cannot disagree. The tone is deliberately flat: the score is
 * plain text in the body colour, a category with nothing in it reads "none" in
 * the faintest ink, and nothing lights up, counts up or congratulates. A
 * finding keeps its state colour as a small mark beside its label, as it does
 * everywhere else in the app.
 */

import { copy } from './copy';
import { HEALTH_ORDER, brainHealth, type HealthInput, type HealthKey, type HealthPart } from './healthScore';

/** Which state colour a category carries — the same split the tidy table uses. */
const TONE: Record<HealthKey, 'crit' | 'warn'> = {
  orphans: 'crit',
  broken: 'crit',
  untagged: 'warn',
  conflicts: 'warn',
};

export function healthLabel(key: HealthKey, count: number): string {
  return copy.health[key](count);
}

function Score({ score }: { score: number | null }): React.JSX.Element {
  if (score === null) return <p className="health-empty">{copy.health.noScore}</p>;
  return (
    <div className="health-score" role="img" aria-label={copy.health.scoreLabel(score)}>
      <span className="health-n">{score}</span>
      <span className="health-of">{copy.health.of100}</span>
      {/* A plain proportion, not a progress bar to fill: no steps, no goal line. */}
      <span className="health-meter" aria-hidden="true">
        <i style={{ width: `${score}%` }} />
      </span>
    </div>
  );
}

function Breakdown({
  parts,
  active,
  showCost,
  onPick,
}: {
  parts: HealthPart[];
  active?: HealthKey | null;
  showCost?: boolean;
  onPick: (key: HealthKey) => void;
}): React.JSX.Element {
  const byKey = new Map(parts.map((part) => [part.key, part]));
  return (
    <ul className="health-parts">
      {HEALTH_ORDER.map((key) => {
        const part = byKey.get(key);
        if (part === undefined) return null;
        const label = healthLabel(key, part.count);
        const empty = part.count === 0;
        return (
          <li key={key}>
            <button
              type="button"
              className="health-part"
              data-empty={empty}
              aria-pressed={active === undefined ? undefined : active === key}
              disabled={empty}
              aria-label={empty ? `${label}: ${part.applies ? copy.health.none : copy.health.notUsed}` : copy.health.showFinding(part.count, label)}
              onClick={() => !empty && onPick(key)}
            >
              <i className={`dot dot-${empty ? 'none' : TONE[key]}`} aria-hidden="true" />
              <span className="health-part-label">{label}</span>
              <span className="health-part-n">
                {empty ? (part.applies ? copy.health.none : copy.health.notUsed) : part.count}
              </span>
              {showCost === true && (
                <span className="health-part-cost" aria-hidden="true">
                  {part.cost >= 0.05 ? copy.health.cost(part.cost.toFixed(1)) : ''}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The compact card on the home view. Every line opens its finding in Tidy up. */
export function HealthCard({
  input,
  stale,
  attention,
  onPick,
  onOpen,
}: {
  input: HealthInput;
  /** Notes untouched past the caller's threshold — shown, not scored. */
  stale: number;
  /** Distinct notes behind all findings, as the server counts them. */
  attention: number;
  onPick: (key: HealthKey | 'stale') => void;
  onOpen: () => void;
}): React.JSX.Element {
  const health = brainHealth(input);
  return (
    <section className="tile health-card" aria-labelledby="health-card-title">
      <p className="cap" id="health-card-title">{copy.health.title}</p>
      <Score score={health.score} />
      <Breakdown parts={health.parts} onPick={onPick} />
      <p className="health-foot">
        {stale > 0 ? (
          <button type="button" className="health-link" onClick={() => onPick('stale')}>
            {copy.health.untouched(stale)}
          </button>
        ) : null}
        {attention > 0 && <span>{copy.health.attention(attention)}</span>}
      </p>
      <button type="button" className="tile-more" onClick={onOpen}>
        {copy.health.open}
      </button>
    </section>
  );
}

/** The head of the tidy view: the same number, with the arithmetic shown. */
export function HealthHeader({
  input,
  stale,
  active,
  onPick,
  onClear,
}: {
  input: HealthInput;
  stale: number;
  active: HealthKey | 'stale' | null;
  onPick: (key: HealthKey | 'stale') => void;
  onClear: () => void;
}): React.JSX.Element {
  const health = brainHealth(input);
  return (
    <section className="health-head" aria-labelledby="health-head-title">
      <div className="health-head-score">
        <h3 className="cap" id="health-head-title">{copy.health.title}</h3>
        <Score score={health.score} />
        <details className="health-how">
          <summary>{copy.health.how}</summary>
          <p>{copy.health.formula}</p>
        </details>
      </div>
      <div className="health-head-parts">
        <Breakdown
          parts={health.parts}
          active={active === 'stale' ? null : active}
          showCost
          onPick={onPick}
        />
        <p className="health-foot">
          {stale > 0 && (
            <button
              type="button"
              className="health-link"
              aria-pressed={active === 'stale'}
              onClick={() => onPick('stale')}
            >
              {copy.health.untouched(stale)}
            </button>
          )}
          {active !== null && (
            <button type="button" className="health-link" onClick={onClear}>
              {copy.health.showAll}
            </button>
          )}
        </p>
      </div>
    </section>
  );
}
