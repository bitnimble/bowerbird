// vcpkg, at one commit of its port tree, for the getters that take something from it. That commit
// fixes every package's version - and the vcpkg tool's - on every machine that builds this
// application, so moving it is moving the codecs and the shader compiler at once.
//
// `native/rawshim/vcpkg/` is the manifest, one feature per getter, and the things vcpkg's defaults
// get wrong for us: an overlay libavif, and triplets that skip debug builds and pin macOS's
// deployment target.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pin, unpack } from './pinned';

const VCPKG = '398e9a716997ec84676dc7c7afdd51afcede2269';
const ROOT = resolve(import.meta.dir, '..');
const MANIFEST = resolve(ROOT, 'native/rawshim/vcpkg');
export const WINDOWS = process.platform === 'win32';
export const TRIPLET = triplet();

/**
 * What a tree installed for `feature` is named by: the commit, the triplet, the manifest, and the
 * `getter` that shapes the tree after vcpkg is done with it.
 */
export function vcpkgRecipe(feature: string, getter: string): string {
  return pin(VCPKG, [feature, TRIPLET, text(getter), text(import.meta.path), ...manifest()]);
}

/**
 * Installs one feature of the manifest into `installed`, from a vcpkg fetched and bootstrapped for
 * the purpose. `tools` is what that feature's ports want installed beyond vcpkg's own needs, and
 * `cached` is whether vcpkg keeps an archive of each port it installs - worth it for a port it
 * compiles, and nothing but disk for one it only downloads.
 */
export function vcpkgInstall(installed: string, feature: string, tools: readonly string[], cached: boolean): void {
  refuseMissingTools(tools);
  // vcpkg's own root and its build trees, somewhere short: the trees nest deep enough to pass
  // Windows' 260-character path limit under a cache directory, and run to gigabytes. Thrown away
  // once the install succeeds, and kept when it does not, since the logs a failure names are in it.
  const work = mkdtempSync(join(tmpdir(), 'bb-vcpkg-'));
  try {
    const name = `${VCPKG}.tar.gz`;
    run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '-o', join(work, name), `https://github.com/microsoft/vcpkg/archive/${name}`]);
    unpack(work, name);
    const root = join(work, `vcpkg-${VCPKG}`);
    if (WINDOWS) run('cmd', ['/c', 'bootstrap-vcpkg.bat', '-disableMetrics'], root);
    else run('sh', ['bootstrap-vcpkg.sh', '-disableMetrics'], root);

    const binaryCache: Record<string, string> = cached ? {} : { VCPKG_BINARY_SOURCES: 'clear' };
    run(join(root, WINDOWS ? 'vcpkg.exe' : 'vcpkg'), [
      'install',
      // Named rather than found, because the CI runners set `VCPKG_ROOT` to the vcpkg they carry,
      // and the tool would build that one's ports instead.
      `--vcpkg-root=${root}`,
      `--x-manifest-root=${MANIFEST}`,
      `--x-install-root=${installed}`,
      `--x-feature=${feature}`,
      `--x-buildtrees-root=${join(work, 'b')}`,
      `--x-packages-root=${join(work, 'p')}`,
      `--downloads-root=${join(work, 'd')}`,
      `--triplet=${TRIPLET}`,
      '--clean-after-build',
    ], root, binaryCache);
  } catch (failed) {
    console.error(`vcpkg's build trees and logs are kept at ${work}`);
    throw failed;
  }
  rmSync(work, { recursive: true, force: true });
}

/**
 * Where a host dependency's `path` landed: under the triplet vcpkg built tools for, which is this
 * machine's and not necessarily `TRIPLET` - on Windows the libraries are static and the tools not.
 */
export function hostPath(installed: string, path: string): string {
  for (const host of readdirSync(installed)) {
    const found = resolve(installed, host, path);
    if (existsSync(found)) return found;
  }
  throw new Error(`vcpkg installed no ${path} under ${installed}`);
}

function triplet(): string {
  const known: Record<string, string> = {
    'linux-x64': 'x64-linux',
    'darwin-arm64': 'arm64-osx',
    'win32-x64': 'x64-windows-static-md',
  };
  const machine = `${process.platform}-${process.arch}`;
  const found = known[machine];
  if (found == null) {
    throw new Error(`no vcpkg triplet for ${machine}: name one here and in native/rawshim/vcpkg/triplets`);
  }
  return found;
}

/** Every file under the manifest directory, so an edit to any of them rebuilds. */
function manifest(): string[] {
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at).sort()) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(`${relative(MANIFEST, path).replaceAll('\\', '/')}\n${text(path)}`);
    }
  };
  walk(MANIFEST);
  return files;
}

/** Line endings normalised, or a Windows checkout would name a different tree for the same file. */
function text(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/**
 * vcpkg fetches its own tools on Windows and expects them installed everywhere else, and says so
 * one port at a time, minutes apart. Asked for here, all at once.
 */
function refuseMissingTools(tools: readonly string[]): void {
  if (WINDOWS) return;
  // A compiler even for a port that only downloads: vcpkg hashes it into every package's ABI.
  const wanted = ['cc', 'c++', 'curl', 'git', 'tar', 'zip', 'unzip', ...tools];
  const missing = wanted.filter((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0);
  if (missing.length > 0) {
    throw new Error(
      `vcpkg needs ${missing.join(', ')}. ` +
        (process.platform === 'darwin' ? `brew install ${missing.join(' ')}` : `sudo apt-get install ${missing.join(' ')}`),
    );
  }
}

function run(command: string, args: string[], cwd = ROOT, env: Record<string, string> = {}): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, VCPKG_DISABLE_METRICS: '1', ...env } });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
  }
}
