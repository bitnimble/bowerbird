// Builds the desktop binary the e2e run drives (see `e2e-tauri/playwright.config.ts`).
//
// One thing a normal build does not do: `tauri/custom-protocol`, the feature the Tauri CLI
// passes for a real build and the switch that takes the binary out of dev mode.
import { spawnSync } from 'node:child_process';
import { ensureIcons } from './make-icons.ts';

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// `generate_context!` reads the icons at compile time and they are generated, not committed, so a
// clean checkout fails inside a proc macro naming a missing file rather than at a build step.
ensureIcons();
run('bun', ['run', '--cwd', 'web', 'build']);
// The server the app carries. Without it the shell builds perfectly and then has
// no library to open, which looks like a broken app rather than a missing step.
run('bun', ['run', 'scripts/build-sidecar.ts']);
// Through `scripts/cargo.ts`, which sweeps the generation this one replaces.
run('bun', [
  'run',
  'scripts/cargo.ts',
  'build',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--features',
  'tauri/custom-protocol',
]);
