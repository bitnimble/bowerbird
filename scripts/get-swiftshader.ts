// Downloads the pinned SwiftShader into the user's cache, which `native/rawshim/.swiftshader/`
// then points at (`pinned.ts` says why it is not in the checkout).
//
//   bun run get:swiftshader
//
// **Only for a machine with no GPU.** SwiftShader is a Vulkan driver that runs on the CPU, and
// nothing uses it unless asked: `bun run test:native --swiftshader ...` points the suite at it, and
// any other process takes it through `VK_ADD_DRIVER_FILES` (AGENTS.md says how). The Docker image
// installs it beside the hardware drivers, which win where present.
//
// **Why not lavapipe**, which is mesa's CPU driver and usually installed already: it binds at most
// 128MiB of storage buffer, the least Vulkan allows, and a 24MP frame is 144MB, so it cannot open a
// real photograph at all. SwiftShader binds 1GiB, which a 61MP frame fits.
//
// **Where this copy comes from.** SwiftShader publishes no binaries of its own, and every other
// Google build embeds it in a product - Chrome for Testing is 266MB of browser around a 4MB driver.
// Android's emulator prebuilts serve the driver alone, and the commit they are pinned to fixes the
// bytes rather than a version, because a CPU driver's rounding is part of what the snapshots are
// held to. Each file is refused unless it hashes to what those snapshots were measured against.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alreadyPinned, linkPinned, makeOnce, pin, pinnedHome, pinnedLink } from './pinned';

const NAME = 'swiftshader';
const COMMIT = 'bbe98768a47ce9166f768e791768ae5f066c04df';
const REPOSITORIES = [
  'https://android.googlesource.com/platform/prebuilts/android-emulator',
  'https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/prebuilts/android-emulator',
  'https://mirrors.ustc.edu.cn/aosp/platform/prebuilts/android-emulator',
];
const VULKAN = 'linux-x86_64/lib64/vulkan';
const GIT_TIMEOUT_MS = 120_000;

const FILES: Record<string, string> = {
  'libvk_swiftshader.so': '9e2cebc35ffd7f0dd234c219f6b3a1150801b4675ccc26498fcdfce8c79064e7',
  'vk_swiftshader_icd.json': 'c0b871d345fda719a548c208d0265b8675151d640d80edec3c78c4d31c30bbb3',
};
const RECIPE = pin(COMMIT, Object.values(FILES));
const HOME = pinnedHome(NAME, RECIPE);

export const ICD = resolve(pinnedLink(NAME), 'vk_swiftshader_icd.json');

function download(): Map<string, Buffer> {
  const failures: string[] = [];
  for (const repository of REPOSITORIES) {
    try {
      return pinnedFiles(repository);
    } catch (thrown) {
      failures.push(String(thrown));
    }
  }
  throw new Error(`no repository had the pinned SwiftShader:\n${failures.join('\n')}`);
}

function pinnedFiles(repository: string): Map<string, Buffer> {
  const scratch = mkdtempSync(join(tmpdir(), 'bb-swiftshader-'));
  const git = (args: string[]): Buffer => {
    const done = spawnSync('git', args, {
      cwd: scratch,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    if (done.status !== 0) {
      const reason = done.error?.message ?? done.stderr.toString().trim();
      throw new Error(`git ${args[0]} from ${repository}: ${reason}`);
    }
    return done.stdout;
  };
  try {
    git(['init', '--quiet']);
    git(['remote', 'add', 'origin', repository]);
    // gigabytes of emulator builds: trees only, `cat-file` fetches each blob it names
    git(['fetch', '--quiet', '--depth=1', '--filter=blob:none', 'origin', COMMIT]);
    const files = new Map<string, Buffer>();
    for (const [name, sha256] of Object.entries(FILES)) {
      const bytes = git(['cat-file', '-p', `${COMMIT}:${VULKAN}/${name}`]);
      const got = createHash('sha256').update(bytes).digest('hex');
      if (got !== sha256) {
        throw new Error(`${name} from ${repository} hashes ${got}, not the pinned ${sha256}`);
      }
      files.set(name, bytes);
    }
    return files;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  // The hashes below are one machine's, so without this an arm64 host downloads an x86_64 driver,
  // verifies it, records it, and fails much later inside the loader's dlopen.
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `SwiftShader is pinned here as ${VULKAN.split('/')[0]}, and this is ${process.platform}-${process.arch}`,
    );
  }

  if (!alreadyPinned(HOME, RECIPE)) {
    const fetched = download();
    makeOnce(HOME, RECIPE, false, () => {
      for (const [name, bytes] of fetched) {
        writeFileSync(resolve(HOME, name), bytes);
      }
    });
  }

  linkPinned(NAME, HOME);
  // The additive one: a hardware adapter is still the one to find where there is one, and
  // `test:native --swiftshader` sets the exclusive `VK_DRIVER_FILES` itself when it wants no other.
  console.log(`SwiftShader ${COMMIT.slice(0, 8)} at ${HOME}: VK_ADD_DRIVER_FILES=${ICD}`);
}

if (import.meta.main) {
  main();
}
