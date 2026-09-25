import { defineConfig } from '@playwright/test';
import { prepareFixture } from './e2e/fixture_library';

prepareFixture();

// Drives the real stack: each worker starts its own API and Vite (`e2e/fixtures.ts`), on
// ports of their own, so neither a dev session nor another checkout's run is disturbed.
//
// Files and their tests are spread over the workers; a file whose tests read what the one
// before them left says `mode: 'serial'`.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 2,
  timeout: 60_000,
  // **Five seconds by default, and anything slower says so at the call site.** Almost
  // everything here is a class toggling or a route resolving, which either happens in
  // milliseconds or is broken - and waiting fifteen seconds to be told that turned a failing
  // suite into a five-minute one. What genuinely takes longer is a decode, a rendition build
  // or a scan, and those are few enough to carry their own timeout where they are awaited.
  expect: { timeout: 5_000 },
  use: {
    trace: 'retain-on-failure',
    // The same bound on the gestures, for the same reason: a click that cannot land is a
    // broken test, not a slow one.
    actionTimeout: 5_000,
    // The editor's tick is WebGPU now, and headless Chromium ships with it off and no GPU
    // process. Without these the editor reports "this browser has no WebGPU" and every
    // editing test fails for a reason that has nothing to do with the app.
    launchOptions: {
      args: [
        '--no-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--ozone-platform=headless',
      ],
    },
  },
  // One engine for the app's behaviour, and a second for the two files whose risk is the
  // engine itself. A whole suite in both would double the run for that much.
  //
  // `grid/bands` because aspect ratios against stretched grid rows and capped flex lines
  // are where the two disagree, and a band of photographs is all three at once.
  // `editor/raw_editing` does not run there: the editor needs WebGPU, which Gecko ships on
  // Windows first, so a Linux run would assert against an engine that cannot open the
  // editor at all. What it used to cover - the three sinks, the rewrap, the thread pool -
  // went with the routes (`docs/raw-edit-gpu.md` §7).
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' }, testMatch: /grid\/bands\.spec\.ts/ },
  ],
});
