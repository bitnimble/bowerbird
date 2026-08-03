import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim());

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
    alias: [
      {
        // Source rather than the `dist` its package.json publishes, and so an alias rather
        // than a dependency: the build output is gitignored, and a fresh checkout should
        // not have to build a sibling package before this one will start. `tsconfig.json`
        // carries the same mapping for the typecheck.
        find: 'avif-hdr-video',
        replacement: fileURLToPath(new URL('../packages/avif-hdr-video/src/index.ts', import.meta.url)),
      },
      {
        // Settings schemas live under ../src and import zod. Vite resolves bare imports
        // from the importer's directory, which is outside this package - pin it to the
        // copy web declares rather than walking into /app/node_modules.
        find: 'zod',
        replacement: fileURLToPath(new URL('./node_modules/zod', import.meta.url)),
      },
    ],
  },
  server: {
    // Random rather than fixed, so several checkouts can run a dev server at
    // once; Vite prints the one it settled on. `-p N` / `--port N` pins it.
    // Not port 0: Vite reads that as "unset" and falls back to its own default,
    // which is the collision this avoids.
    port: 20000 + Math.floor(Math.random() * 20000),
    host: true,
    // Vite refuses any Host header that is not an IP or localhost, which is a
    // DNS-rebinding guard that a reverse proxy forwarding a real hostname trips. Name
    // the hosts, or `all` where the server is already reachable only from a network you
    // trust.
    allowedHosts: allowedHosts?.includes('all') ? true : allowedHosts,
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
});
