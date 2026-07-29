import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is a separate service on its own origin (CORS_ORIGINS must list this
// dev server). VITE_API_URL points the client at it; see src/api/client.ts.
export default defineConfig({
  plugins: [react()],
  // Standard decorators are stage 3, so they must be lowered before Rollup sees
  // them: at target esnext esbuild passes `accessor` through and the build fails
  // to parse.
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
  server: {
    // Random rather than fixed, so several checkouts can run a dev server at
    // once; Vite prints the one it settled on. `-p N` / `--port N` pins it.
    // Not port 0: Vite reads that as "unset" and falls back to its own default,
    // which is the collision this avoids.
    port: 20000 + Math.floor(Math.random() * 20000),
    host: true,
    // The client talks to the API directly on its own origin, so these are not
    // for the app. They exist so the API's own pages are reachable from a device
    // that can only see this port: the HDR check (§10.7) has to be opened on a
    // phone or an HDR desktop, and it pulls its renditions from /image and
    // builds them through /api.
    proxy: Object.fromEntries(
      ['/hdr-check', '/quality-check', '/api', '/image'].map((path) => [
        path,
        { target: process.env.VITE_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: true },
      ]),
    ),
  },
});
