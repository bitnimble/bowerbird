// What the Android app's server runs on that is not in the server bundle: the Bun runtime and the
// two native addons, `libsql` and `@parcel/watcher`, built for the phone, into the user's cache,
// which `native/rawshim/.android-runtime/` then points at (`pinned.ts` says why it is not in the
// checkout).
//
//   bun run get:android-runtime
//
// Each file is named as it ships in the APK's `jniLibs`: Android executes and maps only what its
// package installer unpacked from there, and it unpacks nothing not named `lib*.so`.
//
// `libsql` publishes no Android build, so it is compiled from the tag of the version installed
// beside the bundle. The watcher's is linked for 4 KB pages, which Play refuses, so it is compiled
// from the source `bun install` put beside the bundle. Bun's is refused unless it hashes to the pin.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ANDROID_ABI,
  ANDROID_API,
  ANDROID_PAGE_SIZE_LINK_ARG,
  ANDROID_TARGET,
  androidNdk,
} from './android-ndk';
import { alreadyPinned, fetchPinned, linkPinned, makeOnce, pin, pinnedHome } from './pinned';

const NAME = 'android-runtime';
const ROOT = resolve(import.meta.dir, '..');

export const RUNTIME = 'libbun.so';
export const LIBSQL = 'libbowerbird_libsql.so';
export const WATCHER = 'libbowerbird_watcher.so';

const BUN_SHA256: Record<string, string> = {
  '1.4.2': 'a1c7e2983f1bb65146beb256a4d72449f23042412bc2cf278aa6397ba27e0274',
};
const LIBSQL_COMMITS: Record<string, string> = {
  '0.5.29': '55bee86d1c284f1ddf2b9e280e870d2b6cef884a',
};
const NODE_API_HEADERS = {
  version: '1.9.0',
  sha512:
    '2oNILP4jXwRB4ywnYKjVk1YyJ96n2D4EOVJO6S3oYZ5PtbJrw3Yt9TpAuX3nBLMuzn74rnfGQrv13pS9vC+YiA==',
};
/** `binding.gyp`'s sources for Linux and Android. */
const WATCHER_SOURCES = [
  'binding.cc',
  'Watcher.cc',
  'Backend.cc',
  'DirTree.cc',
  'Glob.cc',
  'Debounce.cc',
  'watchman/BSER.cc',
  'watchman/WatchmanBackend.cc',
  'shared/BruteForceBackend.cc',
  'linux/InotifyBackend.cc',
  'unix/legacy.cc',
];

async function main(): Promise<void> {
  const BUN_VERSION = text('.bun-version').trim();
  const LIBSQL_VERSION = installedVersion('libsql');
  const WATCHER_INTEGRITY = lockedIntegrity(
    `@parcel/watcher@${installedVersion('@parcel/watcher')}`,
  );
  const ADDON_API_INTEGRITY = lockedIntegrity(
    `node-addon-api@${installedVersion('node-addon-api')}`,
  );
  const bunSha256 = BUN_SHA256[BUN_VERSION];
  if (bunSha256 == null) {
    throw new Error(
      `no pinned hash for Bun ${BUN_VERSION}'s Android build: add bun-linux-aarch64-android.zip's from its SHASUMS256.txt`,
    );
  }
  const libsqlCommit = LIBSQL_COMMITS[LIBSQL_VERSION];
  if (libsqlCommit == null) {
    throw new Error(
      `no pinned libsql-js commit for libsql ${LIBSQL_VERSION}: add v${LIBSQL_VERSION}'s`,
    );
  }
  const recipe = pin(BUN_VERSION, [
    bunSha256,
    `libsql ${LIBSQL_VERSION} ${libsqlCommit}`,
    `watcher ${WATCHER_INTEGRITY} ${ADDON_API_INTEGRITY} ${NODE_API_HEADERS.sha512}`,
    text(import.meta.path),
    text('scripts/android-ndk.ts'),
    text('.android-ndk-version'),
    text('rust-toolchain.toml'),
  ]);
  const home = pinnedHome(NAME, recipe);
  const rebuild = process.env.BOWERBIRD_REBUILD_ANDROID_RUNTIME != null;
  if (rebuild || !alreadyPinned(home, recipe)) {
    const bun = await download(
      `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64-android.zip`,
      'sha256',
      bunSha256,
      'hex',
    );
    const headers = await download(
      `https://registry.npmjs.org/node-api-headers/-/node-api-headers-${NODE_API_HEADERS.version}.tgz`,
      'sha512',
      NODE_API_HEADERS.sha512,
      'base64',
    );
    makeOnce(home, recipe, rebuild, () => {
      unpackInto(home, 'bun.zip', bun, ['unzip', '-q'], 'bun-linux-aarch64-android/bun', RUNTIME);
      buildWatcher(home, headers);
      buildLibsql(home, libsqlCommit);
    });
  }
  linkPinned(NAME, home);
  console.log(`android runtime (Bun ${BUN_VERSION}, libsql ${LIBSQL_VERSION}) at ${home}`);
}

async function download(
  url: string,
  algorithm: 'sha256' | 'sha512',
  expected: string,
  encoding: 'hex' | 'base64',
): Promise<Buffer> {
  const bytes = Buffer.from(await (await fetchPinned(url)).arrayBuffer());
  const got = createHash(algorithm).update(bytes).digest(encoding);
  if (got !== expected) throw new Error(`${url} hashes ${got}, not the pinned ${expected}`);
  return bytes;
}

/** One file out of an archive, into `home` under the name it ships as. */
function unpackInto(
  home: string,
  archive: string,
  bytes: Buffer,
  unpacker: string[],
  inside: string,
  as: string,
): void {
  const scratch = mkdtempSync(join(tmpdir(), 'bb-android-'));
  try {
    writeFileSync(join(scratch, archive), bytes);
    run(unpacker[0]!, [...unpacker.slice(1), archive], scratch);
    copyFileSync(join(scratch, inside), join(home, as));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function buildWatcher(home: string, headers: Buffer): void {
  const scratch = mkdtempSync(join(tmpdir(), 'bb-watcher-'));
  try {
    writeFileSync(join(scratch, 'headers.tgz'), headers);
    run('tar', ['xzf', 'headers.tgz'], scratch);
    const { bin } = androidNdk();
    const source = join(ROOT, 'node_modules', '@parcel', 'watcher', 'src');
    run(
      join(bin, `${ANDROID_TARGET}${ANDROID_API}-clang++`),
      [
        '-shared',
        '-fPIC',
        '-O3',
        '-s',
        '-std=c++17',
        '-fstack-protector-strong',
        '-DNAPI_DISABLE_CPP_EXCEPTIONS',
        '-DWATCHMAN',
        '-DINOTIFY',
        '-DBRUTE_FORCE',
        `-I${join(ROOT, 'node_modules', 'node-addon-api')}`,
        `-I${join(scratch, 'package', 'include')}`,
        ANDROID_PAGE_SIZE_LINK_ARG,
        ...WATCHER_SOURCES.map((file) => join(source, file)),
        '-o',
        join(home, WATCHER),
      ],
      scratch,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * libsql-js at the commit its version was tagged at, for the phone, with the repo's own Rust rather
 * than the one libsql-js names, which is the toolchain the Android target is installed for.
 */
function buildLibsql(home: string, commit: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'bb-libsql-'));
  try {
    run('git', ['init', '--quiet'], scratch);
    run(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/tursodatabase/libsql-js.git'],
      scratch,
    );
    run('git', ['fetch', '--quiet', '--depth=1', 'origin', commit], scratch);
    run('git', ['checkout', '--quiet', 'FETCH_HEAD'], scratch);
    const { ndk, env } = androidNdk();
    const toolchain = /channel = "([^"]+)"/.exec(text('rust-toolchain.toml'))?.[1];
    if (toolchain == null) throw new Error('rust-toolchain.toml names no channel');
    run('cargo', ['build', '--release', '--locked', '--target', ANDROID_TARGET], scratch, {
      ...env,
      RUSTUP_TOOLCHAIN: toolchain,
      // libsql's encryption is built by CMake, which compiles for this machine unless handed
      // the NDK's toolchain file.
      CMAKE_TOOLCHAIN_FILE: join(ndk, 'build', 'cmake', 'android.toolchain.cmake'),
      CARGO_NDK_ANDROID_TARGET: ANDROID_ABI,
      ANDROID_PLATFORM: `android-${ANDROID_API}`,
    });
    copyFileSync(
      join(scratch, 'target', ANDROID_TARGET, 'release', 'liblibsql_js.so'),
      join(home, LIBSQL),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function installedVersion(name: string): string {
  const manifest = JSON.parse(text(`node_modules/${name}/package.json`)) as { version: string };
  return manifest.version;
}

/** The lockfile's own hash for a package, so the tarball is held to what `bun install` would be. */
function lockedIntegrity(spec: string): string {
  const quoted = spec.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const found = new RegExp(`\\["${quoted}", "", \\{[^\\n]*\\}, "sha512-([^"]+)"\\]`).exec(
    text('bun.lock'),
  );
  if (found?.[1] == null) throw new Error(`bun.lock holds no integrity for ${spec}`);
  return found[1];
}

function text(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
}

if (import.meta.main) {
  await main();
}
