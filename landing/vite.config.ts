import { fileURLToPath } from 'node:url';
import stylex from '@stylexjs/unplugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  base: '/bowerbird/',
  plugins: [stylex.vite(), react()],
  // Pre-bundled, the dev server deadlocks: StyleX's transform `load`s each import, which for an
  // optimized dep waits on the optimizer, which waits on that transform. No page ever loads.
  optimizeDeps: { exclude: ['@stylexjs/stylex'] },
  resolve: {
    // The ui components read out of `web/` resolve their bare imports from web/node_modules, so
    // without this the page runs two Reacts and every hook in them throws.
    dedupe: ['react', 'react-dom', '@stylexjs/stylex'],
  },
  // The ui components, the tokens and the HDR photographs are read out of `web/`, outside this root.
  server: { fs: { allow: ['..'] } },
  build: {
    rollupOptions: {
      input: { index: page('index.html'), features: page('features.html') },
    },
  },
});
