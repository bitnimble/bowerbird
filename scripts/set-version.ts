// Writes one version into every manifest that carries one.
//
// The tag is the version: every release job runs this before it builds anything, so a
// tagged build cannot ship calling itself something else - which is the failure that makes
// an update check offer a version that is already installed, forever. `src/version.ts`
// imports `package.json`'s, and that is what the running server reports.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

const version = process.argv[2]?.replace(/^v/, '');
if (version == null || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error('usage: bun run scripts/set-version.ts <version>   (e.g. 0.2.0, or v0.2.0)');
  process.exit(1);
}

/**
 * The field has to be found, rather than the file having to change: re-running this for a
 * version already written is a no-op and not a fault, and the failure actually worth
 * catching is a manifest whose version field has moved or gone - which would otherwise
 * write nothing and report success.
 */
function edit(relative: string, field: RegExp, replacement: string): void {
  const path = join(ROOT, relative);
  const before = readFileSync(path, 'utf8');
  if (!field.test(before)) {
    console.error(`[set-version] ${relative} has no version field where one was expected`);
    process.exit(1);
  }
  writeFileSync(path, before.replace(field, replacement));
  console.log(`${relative}: ${version}`);
}

// The first `"version"` of a package manifest is the package's own; a dependency's would
// be nested, and none of these have one before it.
const JSON_VERSION = /"version":\s*"[^"]*"/;

edit('package.json', JSON_VERSION, `"version": "${version}"`);
edit('web/package.json', JSON_VERSION, `"version": "${version}"`);
edit('src-tauri/tauri.conf.json', JSON_VERSION, `"version": "${version}"`);
// Cargo's is the first `version =` at the start of a line, which is under `[package]` here -
// a dependency's version sits inside a table further down, never in that column.
edit('src-tauri/Cargo.toml', /^version = "[^"]*"$/m, `version = "${version}"`);
