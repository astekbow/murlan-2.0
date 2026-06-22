import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ui/ErrorBoundary.tsx';
import { installGlobalErrorLogging } from './lib/errorLog.ts';
import { installWebVitals } from './lib/vitals.ts';
import './index.css';

installGlobalErrorLogging(); // report uncaught errors + rejections to the server log
installWebVitals(); // capture Core Web Vitals (LCP/CLS/TTFB) → the same server log sink

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Register the offline-shell service worker in PRODUCTION only — in dev it would
// fight Vite's HMR (caching dev modules). Failures are non-fatal.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
