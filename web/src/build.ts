/**
 * When the bundle in the browser was built.
 *
 * A single-page app without a router never navigates, so a tab left open goes
 * on running the JavaScript it loaded — across a deploy, and with nothing on
 * screen to say so. That is not a theoretical annoyance: a setting was hunted
 * for in a running tab that predated it, and the search took longer than the
 * feature had taken to build.
 *
 * `__BUILT_AT__` is replaced at build time by `vite.config.ts`. In the test
 * environment and in `vite dev` the replacement may be absent, so the fallback
 * is not defensive noise — it is the value that honestly describes a bundle
 * nobody built for production.
 */
declare const __BUILT_AT__: string | undefined;

/** ISO 8601, seconds precision, UTC. `null` when this was not a real build. */
export const builtAt: string | null =
  typeof __BUILT_AT__ === 'string' && __BUILT_AT__ !== '' ? __BUILT_AT__ : null;

/**
 * The build time as a person reads it, in their own zone, or null.
 *
 * Their zone rather than UTC on purpose: the question behind this line is
 * "is that before or after I deployed", and the deploy happened in the time
 * the person was living in.
 */
export function builtAtLocal(locale: string, at: string | null = builtAt): string | null {
  if (at === null) return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
