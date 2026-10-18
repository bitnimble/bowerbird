// `bun run tauri <args>`, through the pinned CLI (`get-tauri-cli.ts`).
import { spawnSync } from 'node:child_process';
import { cli } from './get-tauri-cli.ts';

const ran = spawnSync(cli(), process.argv.slice(2), { stdio: 'inherit' });
process.exit(ran.status ?? 1);
