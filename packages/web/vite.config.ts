import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Online mode: proxy the game socket to the local room server.
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
