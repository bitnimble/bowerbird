// The installer for one platform: the Tauri CLI over the shell, the bundled server and the web
// build that are already beside it.
//
// A script rather than a line in the release workflow, because the icons have to be drawn first
// and a job that spells the CLI out itself is a job that can forget to. Every argument is passed
// through, so `--target` and `--bundles` read as the CLI's own.
import { spawnSync } from 'node:child_process';
import { ensureIcons } from './make-icons.ts';
import { VERSION } from '../src/version.ts';

// `generate_context!` reads them at compile time and they are generated, not committed, so a
// clean checkout fails inside a proc macro naming a missing file rather than at a build step.
ensureIcons();

// npm's CLI, which is the stock Tauri: the only thing it cannot bundle is CEF, and the platform
// that drew with CEF is paused (§23.7). `get-tauri-cli.ts` builds the one that can, for when that
// comes back - it is not kept in the loop meanwhile because it does not install on an arm64 macOS
// runner at all.
//
// The runtime Linux draws with was named here for the same pause, the feature it named no longer
// being declared:
//
// const runtime = process.platform === 'linux' ? ['--features', 'cef'] : [];

const config = JSON.stringify({ version: VERSION });
const built = spawnSync('bun', ['x', '@tauri-apps/cli', 'build', '--config', config, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (built.status !== 0) process.exit(built.status ?? 1);
