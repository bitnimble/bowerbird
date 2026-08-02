import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// The client is same-origin (src/api/client.ts): this server proxies /api and
// /image to the API, which VITE_API_URL / VITE_API_PORT locate. Nothing in the
// browser knows the API's address, so it need not be reachable from one.
export default defineConfig({
  plugins: [react()],
  // Standard decorators are stage 3, so they must be lowered before Rollup sees
  // them: at target esnext esbuild passes `accessor` through and the build fails
  // to parse.
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
  worker: { format: 'es' },
  resolve: {
    alias: {
      // rawshim's wasm build links wasi-libc for the C runtime LibRaw needs, which makes
      // the module import WASI syscalls it never calls - the RAW is opened from a buffer,
      // so nothing touches a file. The stubs satisfy the import list.
      wasi_snapshot_preview1: '/src/features/raw_edit/wasi_stub.ts',
    },
  },
  server: {
    // Random rather than fixed, so several checkouts can run a dev server at
    // once; Vite prints the one it settled on. `-p N` / `--port N` pins it.
    // Not port 0: Vite reads that as "unset" and falls back to its own default,
    // which is the collision this avoids.
    port: 20000 + Math.floor(Math.random() * 20000),
    host: true,
    headers: isolationHeaders,
    allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()),
    // Everything the browser asks the API for goes through here: this server is
    // the only one exposed, and the API is internal. /quality-check is the API's
    // own diagnostic page, reachable the same way.
    proxy: Object.fromEntries(
      ['/quality-check', '/api', '/image'].map((path) => [
        path,
        {
          target:
            process.env.VITE_API_URL ?? `http://127.0.0.1:${process.env.VITE_API_PORT ?? '3000'}`,
          changeOrigin: true,
        },
      ]),
    ),
  },
  preview: { headers: isolationHeaders },
});
