import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  const dev = command === 'serve';
  const backend = process.env.MCP_WORKER_UI_BACKEND || 'http://127.0.0.1:3333';
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
    base: dev ? '/' : '/assets/ui/',
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '^/(login|register|logout|admin|account|oauth)(/|\\?|$)': {
          target: backend,
          changeOrigin: true,
          // Vite renders SPA documents; POST actions and JSON detail routes
          // still go through the same Express auth/session/CSRF middleware.
          bypass(req) {
            if (req.method === 'GET' && req.headers.accept?.includes('text/html'))
              return '/index.html';
          },
        },
      },
    },
    build: { outDir: '../src/public/ui', emptyOutDir: true, manifest: true },
  };
});
