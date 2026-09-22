// The installer for one platform: the Tauri CLI over the shell, the bundled server and the web
// build that are already beside it.
//
// A script rather than a line in the release workflow, because the icons have to be drawn first
// and a job that spells the CLI out itself is a job that can forget to. Every argument is passed
// through, so `--target` and `--bundles` read as the CLI's own.
import { spawnSync } from 'node:child_process';
import { ensureIcons } from './make-icons.ts';

// `generate_context!` reads them at compile time and they are generated, not committed, so a
// clean checkout fails inside a proc macro naming a missing file rather than at a build step.
ensureIcons();

const built = spawnSync('bun', ['x', '@tauri-apps/cli', 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // linuxdeploy, which assembles the AppImage, is itself an AppImage, so running it mounts one
    // through FUSE - which a container and most CI runners refuse. Told to unpack itself and run
    // from the unpacked copy instead, it needs no kernel support at all.
    APPIMAGE_EXTRACT_AND_RUN: '1',
  },
});
if (built.status !== 0) process.exit(built.status ?? 1);
