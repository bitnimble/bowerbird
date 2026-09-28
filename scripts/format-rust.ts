import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const manifests = [
  'native/rawshim/Cargo.toml',
  'native/heif/Cargo.toml',
  'native/lensdb/Cargo.toml',
  'native/updater/Cargo.toml',
  'native/avif_planes/Cargo.toml',
  'native/avif_planes/parking_lot/Cargo.toml',
  'src-tauri/Cargo.toml',
];

for (const manifest of manifests) {
  const result = spawnSync(
    process.execPath,
    [
      'run',
      join(ROOT, 'scripts/cargo.ts'),
      'fmt',
      '--manifest-path',
      manifest,
      ...process.argv.slice(2),
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.error != null) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
