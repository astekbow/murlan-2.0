import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests so portals (modals/dialogs) don't leak into the
// next test's document.
afterEach(() => cleanup());
