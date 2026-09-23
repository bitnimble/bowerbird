// Fetches the pinned Slang compiler into the user's cache, which `native/rawshim/.slangc/` then
// points at (`pinned.ts` says why it is not in the checkout).
//
//   bun run get:slangc
//
// `build.rs` looks here first and then on `PATH`, and refuses with this command's name when it
// finds neither. Nothing fetches during a build: a compiler that arrives over the network mid-build
// is a build whose output depends on the day it ran.
//
// Through vcpkg (`vcpkg.ts`), which downloads Slang's own release build rather than compiling it,
// so the version is the vcpkg commit's. **Moving that commit moves the compiler, and codegen
// moves with it.** Two Slang releases can lower the same source to arithmetic that differs in the
// last bit, and the snapshots are compared with a tolerance a codegen change can cross, so a bump
// is a deliberate act with the fixtures re-read.
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { linkPinned, makeOnce, pinnedHome } from './pinned';
import { hostPath, vcpkgInstall, vcpkgRecipe, WINDOWS } from './vcpkg';

const NAME = 'slangc';
const FEATURE = 'shaders';
const RECIPE = vcpkgRecipe(FEATURE, import.meta.path);
const HOME = pinnedHome(NAME, RECIPE);
const INSTALLED = resolve(HOME, 'installed');
const BINARY = WINDOWS ? 'slangc.exe' : 'slangc';

function main(): void {
  makeOnce(HOME, RECIPE, process.env.BOWERBIRD_REFETCH_SLANGC != null, () => {
    vcpkgInstall(INSTALLED, FEATURE, [], false);
    // Everything but the compiler's own directory: the port installs Slang a second time as a
    // library to link, and 300MB of debug symbols, and this tree is cached on every CI runner.
    const host = dirname(dirname(tools()));
    for (const entry of readdirSync(host)) {
      if (entry !== 'tools') rmSync(resolve(host, entry), { recursive: true, force: true });
    }
    // 150MB that only a CPU target loads; WGSL never does.
    for (const llvm of ['libslang-llvm.so', 'libslang-llvm.dylib', 'slang-llvm.dll']) {
      rmSync(resolve(tools(), llvm), { force: true });
    }
    // Run from where it landed, so a shared library it cannot find beside it fails here rather
    // than in the middle of a crate build.
    const check = spawnSync(resolve(tools(), BINARY), ['-v'], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(`slangc does not start: ${check.stderr || check.error?.message}`);
  });
  // The tools directory itself, which holds the compiler, the libraries it loads and the standard
  // modules it reads, all beside each other.
  linkPinned(NAME, tools());
  const reported = spawnSync(resolve(tools(), BINARY), ['-v'], { encoding: 'utf8' });
  console.log(`slangc ${(reported.stdout + reported.stderr).trim()} at ${tools()}`);
}

function tools(): string {
  return hostPath(INSTALLED, 'tools/shader-slang');
}

main();
