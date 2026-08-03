import { defineConfig } from '@playwright/test';
import { API_PORT, API_URL, DB_PATH, WEB_PORT, prepareFixture } from './e2e/fixture_library';

prepareFixture();

// Drives the real stack: the Hono API (which needs LibRaw for RAW decoding) and
// the Vite dev server, both on their own random ports so neither a dev session
// nor another checkout's run is disturbed.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
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
  // `band_layout` because aspect ratios against stretched grid rows and capped flex lines
  // are where the two disagree, and a band of photographs is all three at once.
  // `raw_editing` no longer runs there: the editor needs WebGPU, which Gecko ships on
  // Windows first, so a Linux run would assert against an engine that cannot open the
  // editor at all. What it used to cover - the three sinks, the rewrap, the thread pool -
  // went with the routes (`docs/raw-edit-gpu.md` §7).
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
      testMatch: /band_layout\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'bun run src/index.ts',
      cwd: '..',
      url: `${API_URL}/api/libraries`,
      reuseExistingServer: false,
      // The three that are still environment (§15); the run's DB starts empty, so
      // every setting is its default.
      env: { DB_PATH, PORT: String(API_PORT), HOST: '127.0.0.1' },
    },
    {
      command: `./node_modules/.bin/vite --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      // The proxy target: the browser only ever talks to the Vite server.
      env: { VITE_API_URL: API_URL },
    },
  ],
});
