import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests so portals (modals/dialogs) don't leak into the
// next test's document.
afterEach(() => cleanup());

// jsdom doesn't implement ResizeObserver; provide a no-op so components that measure
// their size (e.g. the Hand fan) can render under test.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
