// Builds the desktop binary the WebdriverIO run drives (see `wdio.conf.ts`).
//
// Two things a normal build does not do, both test-only:
//   - `tauri/custom-protocol`, which serves the embedded `frontendDist` instead of the dev
//     URL. It is the feature the Tauri CLI passes for a real build, and the switch that
//     takes the binary out of dev mode.
//   - `withGlobalTauri`, which exposes `window.__TAURI__` for the wdio plugin to wire its
//     execute/mock API onto. Passed by env so a shipped build never carries it.
import { spawnSync } from 'node:child_process';

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('bun', ['run', '--cwd', 'web', 'build']);
run(
  'cargo',
  ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'wdio,tauri/custom-protocol'],
  { TAURI_CONFIG: JSON.stringify({ app: { withGlobalTauri: true } }) },
);
