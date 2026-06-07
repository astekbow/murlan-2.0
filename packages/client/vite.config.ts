import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API + Socket.IO to the game server so the client is same-origin.
// Default to 3100 (NOT 3000 — that collides with a separate local Next.js project,
// "ren4all", and proxying there 400s every /api/auth call). Override with
// MURLAN_API_PORT only if the server's PORT differs.
const apiTarget = `http://localhost:${process.env.MURLAN_API_PORT ?? 3100}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
  // NO source maps in the production bundle: shipping them lets anyone open
  // DevTools → Sources and read the ENTIRE original TypeScript (engine rules,
  // comments, file structure). Off → only the minified/mangled bundle is visible.
  build: { sourcemap: false },
});
