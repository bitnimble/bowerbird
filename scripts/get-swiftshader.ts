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
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alreadyPinned, linkPinned, makeOnce, pin, pinnedHome, pinnedLink } from './pinned';

const NAME = 'swiftshader';
const COMMIT = 'bbe98768a47ce9166f768e791768ae5f066c04df';
const PREBUILTS = 'https://android.googlesource.com/platform/prebuilts/android-emulator';
const VULKAN = 'linux-x86_64/lib64/vulkan';

const FILES: Record<string, string> = {
  'libvk_swiftshader.so': '9e2cebc35ffd7f0dd234c219f6b3a1150801b4675ccc26498fcdfce8c79064e7',
  'vk_swiftshader_icd.json': 'c0b871d345fda719a548c208d0265b8675151d640d80edec3c78c4d31c30bbb3',
};
const RECIPE = pin(COMMIT, Object.values(FILES));
const HOME = pinnedHome(NAME, RECIPE);

export const ICD = resolve(pinnedLink(NAME), 'vk_swiftshader_icd.json');

async function download(name: string, sha256: string): Promise<Buffer> {
  // Gitiles serves a blob as base64 under `?format=TEXT`, and nothing else.
  const url = `${PREBUILTS}/+/${COMMIT}/${VULKAN}/${name}?format=TEXT`;
  const answer = await fetch(url);
  if (!answer.ok) {
    throw new Error(`${url} answered ${answer.status} ${answer.statusText}`);
  }
  const bytes = Buffer.from(await answer.text(), 'base64');
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) {
    throw new Error(`${name} hashes ${got}, not the pinned ${sha256}`);
  }
  return bytes;
}

async function main(): Promise<void> {
  // The hashes below are one machine's, so without this an arm64 host downloads an x86_64 driver,
  // verifies it, records it, and fails much later inside the loader's dlopen.
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `SwiftShader is pinned here as ${VULKAN.split('/')[0]}, and this is ${process.platform}-${process.arch}`,
    );
  }

  if (!alreadyPinned(HOME, RECIPE)) {
    const fetched = new Map<string, Buffer>();
    for (const [name, sha256] of Object.entries(FILES)) {
      fetched.set(name, await download(name, sha256));
    }
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
  await main();
}
