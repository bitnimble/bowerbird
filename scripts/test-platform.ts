import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const filters = process.argv.slice(2);
const scratch = mkdtempSync(join(tmpdir(), 'bb-platform-'));
const data = join(scratch, 'data');
mkdirSync(data);

function selected(name: string): boolean {
  return filters.length === 0 || filters.some((filter) => name.includes(filter));
}

function run(command: [string, ...string[]], cwd = ROOT): void {
  const [program, ...args] = command;
  const result = spawnSync(program, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, DATA_DIR: data, LOG_LEVEL: 'warn', BUN_JSC_useFTLJIT: '0' },
    timeout: 5 * 60 * 1000,
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed with ${result.signal ?? result.status}`);
}

try {
  let count = 0;
  const files = ['src', 'scripts', 'web/src', 'packages', 'test']
    .flatMap((directory) => [...new Bun.Glob('**/*.platform.test.{ts,tsx}').scanSync({ cwd: join(ROOT, directory) })]
      .map((file) => join(directory, file)))
    .map((file) => file.split(sep).join('/'))
    .sort();
  for (const file of files) {
    if (!selected(file)) continue;
    console.log(`platform test: ${file}`);
    run([process.execPath, 'test', join(ROOT, file)], file.startsWith('web/') ? join(ROOT, 'web') : ROOT);
    count++;
  }

  for (const manifest of ['native/updater/Cargo.toml', 'native/lensdb/Cargo.toml']) {
    if (!selected(manifest)) continue;
    console.log(`platform test: ${manifest}`);
    run([process.execPath, 'run', 'scripts/cargo.ts', 'test', '--manifest-path', manifest]);
    count++;
  }

  const exports = 'src-tauri/src/export_paths.rs';
  if (selected(exports)) {
    const executable = join(scratch, process.platform === 'win32' ? 'export-path-tests.exe' : 'export-path-tests');
    console.log(`platform test: ${exports}`);
    run(['rustc', '--edition=2021', '--test', exports, '-o', executable]);
    run([executable]);
    count++;
  }

  if (count === 0) throw new Error(`no platform tests match ${filters.join(', ')}`);
  console.log(`platform suite passed: ${count} test files and native suites`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
