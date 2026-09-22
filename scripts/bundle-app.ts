// The installer for one platform: the Tauri CLI over the shell, the bundled server and the web
// build that are already beside it.
//
// A script rather than a line in the release workflow, because the icons have to be drawn first
// and a job that spells the CLI out itself is a job that can forget to. Every argument is passed
// through, so `--target` and `--bundles` read as the CLI's own.
import { spawnSync } from 'node:child_process';
import { cli } from './get-tauri-cli.ts';
import { ensureIcons } from './make-icons.ts';

// `generate_context!` reads them at compile time and they are generated, not committed, so a
// clean checkout fails inside a proc macro naming a missing file rather than at a build step.
ensureIcons();

// The runtime Linux draws with, named to the bundler rather than left to the manifest, which is
// the only thing that makes it carry CEF - and paused with the rest of that platform (§23.7), the
// feature it names no longer being declared. Back with `release.yml`'s Linux row.
//
// const runtime = process.platform === 'linux' ? ['--features', 'cef'] : [];

const built = spawnSync(cli(), ['build', ...process.argv.slice(2)], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
