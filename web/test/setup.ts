import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// How long `waitFor` and `findBy…` keep looking before they give up. The
// default second is ample on an idle machine and not on a busy one, where a
// render that is merely slow reads as a render that never happened. A waiting
// test that passes stops waiting at once, so a longer ceiling costs only when
// something is really broken.
configure({ asyncUtilTimeout: 5000 });

/**
 * `matchMedia`, which jsdom does not implement, defined once and for good.
 *
 * Eleven test files render the whole shell and stub this themselves, then call
 * `vi.unstubAllGlobals()` when they are done. Vitest runs `afterEach` hooks in
 * reverse registration order, so a file's own hook runs *before* Testing
 * Library's automatic unmount: for a moment the app is still mounted and
 * `window.matchMedia` is gone again.
 *
 * Anything that renders in that moment throws, and the error is charged to
 * whichever test happens to be running — a flake that moves from file to file
 * between runs and reproduces on nobody's machine. A late query answer is enough
 * to cause it, which is why it showed up in a test about a failed tree request
 * and not in the file that caused it.
 *
 * Defining it on the global rather than stubbing it means `unstubAllGlobals`
 * falls back to this instead of to `undefined`. Files that need a particular
 * answer still stub their own on top; they just no longer leave a hole behind.
 *
 * `matches: false` is the honest default for a test environment: jsdom lays
 * nothing out, so no media query is true unless a test says so.
 */
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/**
 * A WebSocket that refuses, at once and predictably.
 *
 * Opening a note starts a live provider, so every test that mounts the shell
 * now has a socket in flight. jsdom's own `WebSocket` accepts the url, tries
 * to reach it for real, and fails on a schedule no test controls — and the
 * state change that failure causes lands *after* the test that caused it has
 * finished, in the window where a file's `afterEach` has already put
 * `matchMedia` back to the `undefined` jsdom ships. A render in that window
 * throws, and the error is charged to whichever test happens to be running.
 * That was a flake that moved from file to file between runs.
 *
 * Refusing immediately is also what these tests mean: none of them serves the
 * socket route, so live editing is unavailable and the editor saves the way it
 * did before — which is the behaviour every one of them was written against.
 * Code 1006 is an abnormal close, the same thing a proxy that does not pass
 * upgrades produces.
 *
 * `test/collab-provider.test.ts` passes its own implementation and is
 * untouched by this.
 */
class RefusingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = RefusingWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = RefusingWebSocket.CLOSED;
      this.onclose?.({ code: 1006 });
    }, 0);
  }

  send(): void {}

  close(): void {
    this.readyState = RefusingWebSocket.CLOSED;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

globalThis.WebSocket = RefusingWebSocket as unknown as typeof WebSocket;
