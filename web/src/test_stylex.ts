import { plugin } from 'bun';
import { unpluginFactory } from '@stylexjs/unplugin';

const hook = unpluginFactory({}, { framework: 'esbuild' }).transform;
const transform = typeof hook === 'function' ? hook : hook?.handler;
if (transform == null) throw new Error('@stylexjs/unplugin has no transform hook');

// `package.json` runs this suite with `BUN_JSC_useFTLJIT=0`: past about twenty of these
// transforms in one process, Bun's top JIT tier miscompiles the parser StyleX reads a media
// query with, and a component whose styles have not changed fails to compile with "Invalid
// media query syntax". jsdom's own tokenizer trips over the same miscompile in
// `getComputedStyle`. `scripts/vite.ts` carries the same flag, the measurements and the issue.
plugin({
  name: 'stylex',
  setup(build) {
    build.onLoad({ filter: /\/(web|landing)\/src\/.*\.tsx?$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      // The hook reads nothing off its bundler context.
      const compiled = await transform.call(undefined as never, source, path);
      const code = typeof compiled === 'string' ? compiled : compiled?.code;
      return { contents: code ?? source, loader: path.endsWith('x') ? 'tsx' : 'ts' };
    });
  },
});
