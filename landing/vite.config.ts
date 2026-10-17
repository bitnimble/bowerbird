import { fileURLToPath } from 'node:url';
import mdx from '@mdx-js/rollup';
import stylex from '@stylexjs/unplugin';
import react from '@vitejs/plugin-react';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { defineConfig } from 'vite';
import { viteAllowedHosts } from '../scripts/vite_allowed_hosts';

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  base: '/',
  plugins: [
    {
      enforce: 'pre',
      ...mdx({
        providerImportSource: '@mdx-js/react',
        remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter],
      }),
    },
    stylex.vite(),
    react({ include: /\.(mdx|tsx?)$/ }),
  ],
  // Pre-bundled, the dev server deadlocks: StyleX's transform `load`s each import, which for an
  // optimized dep waits on the optimizer, which waits on that transform. No page ever loads.
  optimizeDeps: { exclude: ['@stylexjs/stylex'] },
  resolve: {
    // The ui components read out of `web/` resolve their bare imports from web/node_modules, so
    // without this the page runs two Reacts and every hook in them throws.
    dedupe: ['react', 'react-dom', '@stylexjs/stylex'],
    // Source, as `web/vite.config.ts` takes it: the package's `dist` is never built here.
    alias: { 'avif-hdr-video': page('../packages/avif-hdr-video/src/index.ts') },
  },
  server: {
    // The ui components, the tokens and the swatch strip are read out of `web/`, outside this root.
    fs: { allow: ['..'] },
    host: process.env.LANDING_HOST ?? '0.0.0.0',
    port: Number(process.env.LANDING_PORT ?? 5174),
    // An asked-for port that silently moves is worse than a failure.
    strictPort: true,
    allowedHosts: viteAllowedHosts(),
  },
  build: {
    rollupOptions: {
      input: { index: page('index.html'), features: page('features.html'), hdr: page('hdr.html') },
    },
  },
});
