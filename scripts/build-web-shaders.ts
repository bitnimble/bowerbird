// The shaders the browser's viewer stage draws with, compiled the way every other shader is.
//
//   bun run build:web-shaders
//
// **`build.rs` cannot do this one.** It writes into `$OUT_DIR`, which is cargo's and which Vite has
// no path to, and the web app is built on machines that never run cargo at all. So the same pinned
// `slangc` is run again here, over the shaders `slang/` holds for the browser, into a gitignored
// directory the app imports with `?raw`.
//
// Everything else about it is `build.rs`'s rule: the pinned compiler first, then `BOWERBIRD_SLANGC`,
// then `PATH`, and a refusal naming both rather than a stage quietly left out.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Off the module's URL rather than `import.meta.dir`, which is Bun's alone: Vite bundles the
// config that imports this with esbuild and runs it under Node, where that field is undefined and
// every path below it resolves to nothing.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SLANG = resolve(ROOT, 'slang');
const OUT = resolve(ROOT, 'web/src/features/photos/generated');

/// The shaders the browser compiles, and nothing else: the rest of `slang/` is dispatched by
/// `native/rawshim` and reaches the editor through wasm rather than through Vite.
const SHADERS = ['stage.slang', 'stage_import.slang'];

/** The pinned compiler, the one an environment names, or whatever is on `PATH`. */
function slangc(): string {
  const named = process.env.BOWERBIRD_SLANGC;
  if (named != null && existsSync(named)) return named;
  const pinned = resolve(ROOT, 'native/rawshim/.slangc/bin/slangc');
  if (existsSync(pinned)) return pinned;
  for (const at of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(at, 'slangc');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'no Slang compiler: `bun run get:slangc` fetches the pinned build, BOWERBIRD_SLANGC names ' +
      'another, or put one on PATH',
  );
}

/** Every browser shader compiled into `web/src/features/photos/generated`. */
export function buildWebShaders(): void {
  const compiler = slangc();
  mkdirSync(OUT, { recursive: true });
  for (const shader of SHADERS) {
    const to = resolve(OUT, shader.replace('.slang', '.wgsl'));
    const run = spawnSync(compiler, [shader, '-target', 'wgsl', '-o', to], {
      cwd: SLANG,
      encoding: 'utf8',
    });
    if (run.status !== 0) {
      throw new Error(`${shader} did not compile:\n${run.stderr || run.stdout}`);
    }
  }
  // Nothing generated is committed, which is the same rule `$OUT_DIR/wgsl` follows.
  writeFileSync(resolve(OUT, '.gitignore'), '*\n');
}

if (import.meta.main) {
  buildWebShaders();
  console.log(`compiled ${SHADERS.length} shader(s) into ${OUT}`);
}
