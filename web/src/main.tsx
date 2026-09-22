import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider, onlineManager } from '@tanstack/react-query';

import { App } from './App';
import { Boundary } from './Boundary';
import { createQueryClient } from './queries';
import './styles.css';

/**
 * What the cache believes about the connection before anything has happened.
 *
 * The online manager starts out assuming it is online and only learns otherwise
 * from the browser's `offline` event — which never fires for the page that was
 * *opened* offline. Without this line, a tab reloaded on a dead connection sends
 * requests it cannot send and shows them as loading, which is the exact failure
 * this is meant to end. `navigator.onLine` is a weak signal (it says "there is a
 * network", not "the server is reachable"), and it is only ever consulted here,
 * where a false "online" costs nothing but a failed request.
 */
onlineManager.setOnline(navigator.onLine);

const queryClient = createQueryClient();

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
