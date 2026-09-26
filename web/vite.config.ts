import { fileURLToPath } from 'node:url';
import { type ViteDevServer, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin';
import { SLANG, buildWebShaders } from '../scripts/build-web-shaders';
import { PathSegment, route } from '../src/schemas/route';
import { CROSS_ORIGIN_ISOLATION } from '../src/schemas/isolation';

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '');

// The viewer's stage is Slang like every other shader, so it has to be compiled before anything
// imports it. Here rather than in a package.json script because both `dev` and `build` start
// through Vite, and a step spelt in one of them is a step the other silently skips.
const shaders = {
  name: 'bowerbird-web-shaders',
  buildStart: () => buildWebShaders(),
  configureServer(server: ViteDevServer) {
    // `slang/` is outside this root, so nothing watches it unless it is named - and a dev
    // server otherwise keeps serving whatever WGSL it started with, which is a shader and a
    // host disagreeing about a uniform: a drawn picture rather than an error.
    server.watcher.add(SLANG);
    server.watcher.on('change', (file) => {
      if (!file.endsWith('.slang')) return;
      try {
        buildWebShaders();
      } catch (err) {
        server.config.logger.error(String(err));
        return;
      }
      server.ws.send({ type: 'full-reload' });
    });
  },
};

// The client is same-origin (web/src/api/transport.ts): this server proxies /api and
// /image to the API, which VITE_API_URL / VITE_API_PORT locate. Nothing in the
// browser knows the API's address, so it need not be reachable from one.
export default defineConfig({
  plugins: [shaders, stylex.vite(), react()],
  // Pre-bundled, the dev server deadlocks: StyleX's transform `load`s each import, which for an
  // optimized dep waits on the optimizer, which waits on that transform. No page ever loads.
  optimizeDeps: { exclude: ['@stylexjs/stylex'] },
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
  preview: { headers: CROSS_ORIGIN_ISOLATION },
  server: {
    headers: CROSS_ORIGIN_ISOLATION,
    // The decoder's wasm package is built into `native/rawshim/pkg`, a sibling of this root, and
    // Vite serves nothing above its root without being told to.
    fs: { allow: ['..'] },
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
      [PathSegment.qualityCheck(), PathSegment.api(), PathSegment.image()].map((segment) => [
        route(segment),
        {
          target:
            process.env.VITE_API_URL ?? `http://127.0.0.1:${process.env.VITE_API_PORT ?? '3000'}`,
          changeOrigin: true,
        },
      ]),
    ),
  },
});
