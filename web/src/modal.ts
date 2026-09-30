/**
 * What every panel laid over the page owes a keyboard.
 *
 * Three things, and they are always the same three, which is why they live here
 * rather than in each panel:
 *
 *  - the focus goes *in* when it opens, so the next key lands in the panel and
 *    not in the page behind it
 *  - the focus stays in while it is open, so Tab cannot walk out of a panel
 *    that is drawn over everything and leave the caret somewhere invisible
 *  - the focus comes *back* when it closes, to whatever opened it, so the next
 *    key carries on where the person was rather than at the top of the document
 *
 * `Menu.tsx` already did all three by hand for a pop-up menu, and it is the
 * reason this is written the way it is. What it does not do is trap, because a
 * menu should not: Tab out of a menu closes it, as it does in every desktop
 * application. A panel over the whole page is the other case — there is nowhere
 * outside it to go while it is open.
 *
 * Trapping rather than relying on `inert` alone, deliberately. `inert` on the
 * page behind is the right thing to say and it is said too, but it is a
 * statement to the browser and to a screen reader; the trap is what holds in
 * the test, and what holds in a browser that has an element `inert` cannot
 * reach — a native `<dialog>` we do not use, an overlay somewhere else in the
 * tree.
 */

import { useEffect, useRef, type RefObject } from 'react';

/**
 * What the browser will move the focus to with Tab.
 *
 * `tabindex="-1"` is excluded from every one of them, and that is the part
 * worth saying out loud: it means "focusable, but not a stop on the way
 * through", and it is put on elements that are natively focusable precisely to
 * take them out of the order. The palette's rows are `<button>`s carrying it,
 * because the field owns the focus and names the active row; matching them as
 * buttons regardless put them back in the walk and pulled the focus out of the
 * field on the first Tab.
 *
 * `[hidden]` and `disabled` are the two other states that take an element out
 * of the order by attribute rather than by style. Style is the browser's
 * business, and the walk below copes with an element that refuses the focus
 * anyway.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
]
  .map((one) => `${one}:not([hidden]):not([tabindex="-1"])`)
  .join(',');

/** The tab stops inside one element, in the order Tab visits them. */
export function tabStops(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Moves the focus one tab stop on, wrapping at either end of `box`.
 *
 * Walks on past a stop that refuses the focus instead of stopping there. An
 * element hidden by CSS is still in `tabStops` — its `display` is not readable
 * from the markup, and in jsdom there is no layout to read at all — but calling
 * `focus()` on it does nothing and would otherwise leave the focus behind on
 * whatever had it.
 */
function step(box: HTMLElement, forwards: boolean): void {
  const stops = tabStops(box);
  if (stops.length === 0) {
    box.focus();
    return;
  }

  const from = stops.indexOf(document.activeElement as HTMLElement);
  // Not on a stop — the container itself, or nothing — so Tab starts at the
  // first stop and Shift+Tab at the last.
  const start = from === -1 ? (forwards ? 0 : stops.length - 1) : from + (forwards ? 1 : -1);

  for (let i = 0; i < stops.length; i += 1) {
    const at = stops[(((start + (forwards ? i : -i)) % stops.length) + stops.length) % stops.length]!;
    at.focus();
    if (document.activeElement === at) return;
  }
}

/**
 * Keeps the keyboard inside an open panel and gives it back when the panel goes.
 *
 * `box` is the panel. `onClose` is what Escape does — the hook only asks; the
 * caller decides, because closing is the caller's state. `initial` names where
 * the focus lands on opening; without one it goes to the panel itself, which
 * has to carry `tabIndex={-1}` for that to work and is the better default for a
 * panel holding a list of things — a screen reader then reads the panel's own
 * name first, and the first Tab goes to the first thing in it.
 *
 * The listener is on the document rather than on the panel, so a key pressed
 * while the focus has somehow ended up outside it still comes back here. It is
 * a capture listener for the same reason Escape has to be: something inside may
 * stop the event on the way up, and the panel would then never close.
 *
 * `active` is the only thing the effect depends on, and that is load-bearing
 * rather than an optimisation. Callers pass `onClose` as `() => setOpen(false)`
 * — a new function on every render — and the shell re-renders constantly while
 * a panel is open: a poll answers, a filter is typed, a query settles. With
 * `onClose` in the dependencies, every one of those tears the effect down and
 * builds it again, which hands the focus back to whatever opened the panel,
 * puts it on the panel, and records the panel as the place to hand it back to.
 * Typing inside the panel then becomes impossible and the way back out is
 * lost. So the callback is read through a ref, and the effect runs when the
 * panel opens and when it closes, which is when anything should happen.
 */
export function useModalFocus(
  active: boolean,
  box: RefObject<HTMLElement | null>,
  onClose: () => void,
  initial?: RefObject<HTMLElement | null>,
): void {
  const close = useRef(onClose);
  close.current = onClose;
  const landOn = useRef(initial);
  landOn.current = initial;

  useEffect(() => {
    if (!active) return;
    const panel = box.current;
    if (panel === null) return;

    // Where to give it back. An element that has left the document by the time
    // the panel closes gets nothing rather than an exception.
    const before = document.activeElement as HTMLElement | null;
    (landOn.current?.current ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      event.preventDefault();
      step(panel, !event.shiftKey);
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (before !== null && before.isConnected) before.focus();
    };
  }, [active, box]);
}
