// Runs the desktop suite against the shell as it ships: it starts its own server, in a home of
// its own so the run uses a scratch catalogue rather than the reader's.
import { spawn } from 'bun';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostTriple } from './host-triple.ts';

const ROOT = join(import.meta.dir, '..');
const HOME = join(tmpdir(), 'bowerbird-e2e-shell');

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

// Under `xvfb-run` because the binary the config launches is a real windowed app, and the
// display has to be there before it starts rather than around the test process only.
const suite = spawn(
  ['xvfb-run', '-a', './node_modules/.bin/playwright', 'test', '--config', 'e2e-tauri/playwright.config.ts'],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME,
      XDG_DATA_HOME: join(HOME, 'data'),
      XDG_CONFIG_HOME: join(HOME, 'config'),
      BOWERBIRD_SIDECAR: join(ROOT, 'src-tauri', 'binaries', `bowerbird-server-${hostTriple()}`),
      BOWERBIRD_RESOURCES: join(ROOT, 'src-tauri', 'resources'),
      BOWERBIRD_WEB: join(ROOT, 'web', 'dist'),
      // Empty turns update checking off (§23.5): left on, the sidebar grows a row the moment a
      // release exists that is newer than this checkout, and the suite depends on what is published.
      BOWERBIRD_UPDATE_REPO: '',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
process.exitCode = await suite.exited;
rmSync(HOME, { recursive: true, force: true });
