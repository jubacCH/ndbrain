import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// How long `waitFor` and `findBy…` keep looking before they give up. The
// default second is ample on an idle machine and not on a busy one, where a
// render that is merely slow reads as a render that never happened. A waiting
// test that passes stops waiting at once, so a longer ceiling costs only when
// something is really broken.
configure({ asyncUtilTimeout: 5000 });

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
