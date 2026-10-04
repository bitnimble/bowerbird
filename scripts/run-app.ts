// The desktop app straight out of `target/`, without installing it, against the server, resources
// and page `build:app` left in the checkout. It uses the installed app's data directory.
//
//   bun run build:app --no-bundle   (skips the installer)
//   bun run app
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostTriple } from './host-triple.ts';

const ROOT = join(import.meta.dir, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
// Cargo's name for the binary, or the product's where the Tauri CLI renamed it.
const app = ['app', 'Bowerbird']
  .map((name) => join(ROOT, 'src-tauri', 'target', 'release', `${name}${exe}`))
  .find((path) => existsSync(path));
if (app == null)
  throw new Error('no app in src-tauri/target/release: run `bun run build:app --no-bundle`');

const ran = spawnSync(app, process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    BOWERBIRD_SIDECAR: join(
      ROOT,
      'src-tauri',
      'binaries',
      `bowerbird-server-${hostTriple()}${exe}`,
    ),
    BOWERBIRD_RESOURCES: join(ROOT, 'src-tauri', 'resources'),
    BOWERBIRD_WEB: join(ROOT, 'web', 'dist'),
  },
});
if (ran.error != null) throw ran.error;
process.exit(ran.status ?? 1);
