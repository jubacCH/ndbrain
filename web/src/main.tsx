import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { Boundary } from './Boundary';
import './styles.css';

/**
 * The cache the whole application reads the server through.
 *
 * `retry: false` because this server is one hop away on a LAN: a failure here is
 * almost always a real answer — signed out, gone, refused — and retrying it three
 * times only delays telling somebody. `refetchOnWindowFocus` is off for the same
 * reason it would be tempting to leave on: coming back to a tab must not pull the
 * text out from under a half-written note.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <Boundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </Boundary>
  </StrictMode>,
);

/**
 * Registers the service worker.
 *
 * Only over HTTPS or on localhost — browsers refuse it elsewhere, and attempting
 * it on a plain-HTTP LAN address produces a console error that looks like a bug
 * but is the browser working correctly.
 */
if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Not fatal: the app is fully functional without it, just slower to start.
    });
  });
}
