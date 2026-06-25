import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the optional prose API to the local Express server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
