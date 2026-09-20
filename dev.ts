import { watch } from 'node:fs';
import path from 'node:path';
import { Logger } from './src/logger';

// Runs the API under `bun --watch` and adds the one thing that mode cannot see.
// `librawshim.so` is dlopen'd, not imported, so it is not in the module graph the
// watcher reloads on - and a process that has loaded a library keeps that copy for
// the rest of its life, however many times the file underneath is replaced. So
// watch the build output too, and restart the whole process when `bun run
// build:native` lands a new one.
const LIB = path.join(import.meta.dir, 'native/rawshim/target/quick/librawshim.so');
const log = new Logger('dev');

function start(): Bun.Subprocess {
  return Bun.spawn(['bun', '--watch', 'run', 'src/index.ts'], { stdio: ['inherit', 'inherit', 'inherit'] });
}

let child = start();
let pending: ReturnType<typeof setTimeout> | undefined;
let restarts = Promise.resolve();

function restart(): void {
  // cargo writes the output more than once on its way to the final link, and
  // restarting on the first event would dlopen a half-written library.
  clearTimeout(pending);
  pending = setTimeout(() => {
    // One at a time: a rebuild landing while the last restart is still waiting for
    // the old process would kill it twice and start two servers on the one port.
    restarts = restarts.then(async () => {
      log.info('librawshim rebuilt, restarting');
      child.kill();
      await child.exited; // the API port is not free until it has actually gone
      child = start();
    });
  }, 300);
}

try {
  // The directory, not the file: cargo replaces the .so rather than writing through
  // it, and a watch on the old inode goes deaf the first time it does.
  watch(path.dirname(LIB), (_event, name) => {
    if (name === path.basename(LIB)) restart();
  });
} catch {
  log.warn('no local native build to watch; a rebuild will need a manual restart', { path: LIB });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    child.kill();
    process.exit(0);
  });
}
