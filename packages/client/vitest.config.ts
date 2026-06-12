import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Test runner config (separate from vite.config.ts so the dev/build pipeline is
// untouched). jsdom gives component/hook tests a DOM; the existing pure-logic
// lib/*.test.ts files run here too.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
