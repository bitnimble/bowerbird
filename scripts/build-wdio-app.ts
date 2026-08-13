// Builds the desktop binary the WebdriverIO run drives (see `wdio.conf.ts`).
//
// One thing a normal build does not do: `tauri/custom-protocol`, which serves the embedded
// `frontendDist` instead of the dev URL. It is the feature the Tauri CLI passes for a real
// build, and the switch that takes the binary out of dev mode.
//
// It used to pass `withGlobalTauri` by env as well, with a comment saying that kept it out
// of a shipped build. It does not and cannot: `tauri.conf.json` sets it for every build, and
// has to, because `transport.ts` reaches the shell through `window.__TAURI__.core.invoke` -
// so the override set what was already set and the comment described the opposite of what
// ships.
import { spawnSync } from 'node:child_process';

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('bun', ['run', '--cwd', 'web', 'build']);
// Through `scripts/cargo.ts`, which sweeps the generation this one replaces.
run('bun', [
  'run',
  'scripts/cargo.ts',
  'build',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--features',
  'wdio,tauri/custom-protocol',
]);
