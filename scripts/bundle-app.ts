// The installer for one platform: the Tauri CLI over the shell, the bundled server and the web
// build that are already beside it.
//
// A script rather than a line in the release workflow, because the icons have to be drawn first
// and a job that spells the CLI out itself is a job that can forget to. Every argument is passed
// through, so `--target` and `--bundles` read as the CLI's own.
import { spawnSync } from 'node:child_process';
import { cli } from './get-tauri-cli.ts';
import { ensureIcons } from './make-icons.ts';
import { VERSION } from '../src/version.ts';

// `generate_context!` reads them at compile time and they are generated, not committed, so a
// clean checkout fails inside a proc macro naming a missing file rather than at a build step.
ensureIcons();

// The CEF AppImage bundler runs FabianLars's fork of `quick-sharun.sh`, whose default URLs for
// these two 404 and fail every AppImage.
const SHARUN_FORK =
  'https://raw.githubusercontent.com/FabianLars/Anylinux-AppImages/3e280d1b2270fecfcb2c2c823b490c782ecf1277/useful-tools/lib';
const env = {
  ...process.env,
  ANYLINUX_LIB_SOURCE: `${SHARUN_FORK}/anylinux.c`,
  GTK_CLASS_FIX_SOURCE: `${SHARUN_FORK}/gtk-class-fix.c`,
};

const config = JSON.stringify({ version: VERSION });
const built = spawnSync(cli(), ['build', '--config', config, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
if (built.status !== 0) process.exit(built.status ?? 1);
