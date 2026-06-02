import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API + Socket.IO to the game server so the client is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: { sourcemap: true },
});
