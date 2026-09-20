// Every Vite this repo starts - `web`, the landing site, Playwright's own server - goes through
// here, so that neither of the two things below is one caller's job to remember.

import { dirname, join } from 'node:path';

// Bun's FTL tier miscompiles the token parser StyleX reads a media query with: past about
// twenty transforms in a process, `@media (pointer: coarse)` starts coming back "Invalid media
// query syntax" on a file nobody touched, and the dev server answers with an error page for
// whichever components crossed the tier-up. Measured on the same file repeated: first failure
// at 20 and almost every one after, none in 40 with this flag or with the DFG tier alone, and
// a whole `bun run build` a second slower for it. `web/src/test_stylex.ts` runs the same
// transform and needs the same flag. JavaScriptCore types `codePointAt` past the end as an
// Int32 and folds the compare against undefined away, so the tokenizer's end-of-input check
// stops agreeing with its own next-token read: oven-sh/bun#41609, fixed by WebKit#578, which
// no Bun release carries yet. Drop the flag when one does.
if (process.env.BUN_JSC_useFTLJIT == null) {
  const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, BUN_JSC_useFTLJIT: '0' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  process.exit(await child.exited);
}

// Vite picks a random port when it is not given one (`vite.config.ts`), which is what lets
// several of these run side by side. A caller that has told something else where to look has
// to say the port here too: `src-tauri/tauri.conf.json` points the webview at 5199 and starts
// this with `--port 5199` for exactly that reason, and without the second half `tauri dev`
// polls a port nothing is listening on and gives up before opening a window.

// Vite's CLI is strict and only knows --port, so rewrite -p before handing over.
process.argv = process.argv.map((arg) => (arg === '-p' ? '--port' : arg));
// An asked-for port that silently moves is worse than a failure.
if (process.argv.includes('--port') && !process.argv.includes('--strictPort')) process.argv.push('--strictPort');
// Resolved from the working directory rather than this file: `web` and `landing` are separate
// installs, and each has to run its own Vite against its own config.
await import(join(dirname(Bun.resolveSync('vite/package.json', process.cwd())), 'bin/vite.js'));
