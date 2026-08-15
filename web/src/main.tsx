import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { Boundary } from './Boundary';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <Boundary>
      <App />
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
